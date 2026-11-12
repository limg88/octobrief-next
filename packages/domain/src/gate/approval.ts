import { canonicalText } from '../canonical.ts'
import { DEFAULT_FRESHNESS, type FreshnessThresholds, tightenFreshness } from '../freshness.ts'
import type { Lang } from '../language/index.ts'
import { canonicalHash } from '../recipe/hash.ts'
import { recipeText } from '../recipe/messages/index.ts'
import type { RunStatus } from '../recipe/run.ts'
import { type Acceptance, isAcceptanceReason } from './acceptance.ts'
import type { InternalDocument } from './audience.ts'
import { type PmDecision, statusOf } from './decisions.ts'
import {
  type RedTeamContext,
  type RedTeamResult,
  type RedTeamRow,
  type RedTeamSummary,
  redTeamRows,
  runRedTeam,
  summarizeRedTeam,
} from './red-team.ts'
import {
  type DetailObject,
  isRedTeamWarningCode,
  RED_TEAM_ANOMALIES,
  RED_TEAM_WARNINGS,
  type RedTeamAnomaly,
  type RedTeamPlace,
  type RedTeamRef,
  type RedTeamWarning,
  refKeyOf,
} from './red-team-model.ts'

// The approval of a revision: the red-team judged again by the code on the stored draft, never
// read from the stored checks; what still stops the approval; the state of the revision and the
// actions the PM has on it, each with the reason when it is not available.

// Story points ---------------------------------------------------------------------------------

/** The explicit confirmation of the PM on a warning that asks for one (story points). */
export interface StoryPointsConfirmation {
  code: string
  refKey: string
  contentHash: string
  reason: string
  by: string
  at: string
}

export type ConfirmationRefusal = 'not_confirmable' | 'reason_too_short'

export type ConfirmationResult =
  | { ok: true; confirmation: StoryPointsConfirmation }
  | { ok: false; refusal: ConfirmationRefusal }

/** Whether a warning with this code asks for an explicit confirmation before approval. */
export function needsConfirmation(code: string): boolean {
  return isRedTeamWarningCode(code) && RED_TEAM_WARNINGS[code].requiresConfirmation
}

/** Confirms a warning that asks for it, with a reason, bound to its place and content. */
export function confirmStoryPoints(
  warning: { code: string; refKey: string; contentHash: string },
  input: { reason: string; by: string; at: string },
): ConfirmationResult {
  if (!needsConfirmation(warning.code)) return { ok: false, refusal: 'not_confirmable' }
  const reason = canonicalText(input.reason)
  if (!isAcceptanceReason(reason)) return { ok: false, refusal: 'reason_too_short' }
  return {
    ok: true,
    confirmation: {
      code: warning.code,
      refKey: warning.refKey,
      contentHash: warning.contentHash,
      reason,
      by: input.by,
      at: input.at,
    },
  }
}

/** Whether the PM confirmed this very warning, on this very content. */
export function isConfirmed(
  warning: { code: string; refKey: string; contentHash: string },
  confirmations: readonly StoryPointsConfirmation[],
): boolean {
  return confirmations.some(
    (c) =>
      c.code === warning.code &&
      c.refKey === warning.refKey &&
      c.contentHash === warning.contentHash &&
      isAcceptanceReason(c.reason),
  )
}

// The red-team judged again -------------------------------------------------------------------

/** A stored row of the red-team, with its id: what the PM accepts, decides or confirms. */
export interface StoredCheck extends RedTeamRow {
  id: string
}

export type ApprovalBlocker =
  /**
   * Found only now, not yet stored (a source aged or removed since the draft, a value or the
   * recipe changed): stored by `lateFindingRows`, then accepted or decided like any other.
   */
  | 'finding_after_draft'
  /** An anomaly still open: to accept, or to fix with a new draft. */
  | 'anomaly_open'
  /** A contradiction or a changed declared value the PM has not decided. */
  | 'decision_missing'
  /** Story points in a client version, not confirmed. */
  | 'story_points_unconfirmed'

export const APPROVAL_BLOCKERS: readonly ApprovalBlocker[] = [
  'finding_after_draft',
  'anomaly_open',
  'decision_missing',
  'story_points_unconfirmed',
]

export interface RecheckedAnomaly extends RedTeamAnomaly {
  /** The stored row of the same finding, which the PM acts on; null when found only now. */
  checkId: string | null
}

export interface RecheckedWarning extends RedTeamWarning {
  checkId: string | null
  confirmed: boolean
}

export interface RecheckInput {
  document: InternalDocument
  /** The context of the red-team, without the reviewer: the model never runs again here. */
  context: RedTeamContext
  /** The stored rows of the revision: only the findings of the model reviewer are taken from them. */
  storedRows: readonly StoredCheck[]
  /** What was removed at the source since: evidence ids and fact ids. */
  removed: { evidence: ReadonlySet<string>; facts: ReadonlySet<string> }
  confirmations: readonly StoryPointsConfirmation[]
  /**
   * The fingerprints of the recipe and of its settings in the project now, when they differ from
   * those of the snapshot of the run; absent when they are the same.
   */
  recipeChanged?: { recipeHash: string; settingsHash: string | null }
}

export interface Recheck {
  anomalies: RecheckedAnomaly[]
  warnings: RecheckedWarning[]
  summary: RedTeamSummary
  /** What stops the approval, in a fixed order, with how many findings. */
  blockers: Array<{ code: ApprovalBlocker; count: number }>
  skeletonHash: string
  dataHash: string
}

const REVIEWER_CODES = new Set(['reviewer_finding', 'reviewer_failed'])

function refOfRow(row: RedTeamRow): RedTeamRef {
  try {
    const parsed: unknown = JSON.parse(row.ref)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as RedTeamRef
    }
  } catch {
    // A ref that is not JSON keeps the place of the whole check.
  }
  return { element: 'check', check: row.code }
}

const placeOfRow = (d: DetailObject): RedTeamPlace =>
  typeof d.place === 'object' && d.place !== null && !Array.isArray(d.place)
    ? (d.place as RedTeamPlace)
    : {}

/**
 * The findings of the model reviewer, which the code cannot judge again: taken from the stored
 * rows, only ever adding anomalies. A recipe with rules whose review is not stored counts as a
 * review that did not happen.
 */
function reviewerOf(
  rows: readonly StoredCheck[],
  ctx: RedTeamContext,
): { anomalies: RedTeamAnomaly[]; tally: RedTeamResult['reviewer'] } {
  const anomalies: RedTeamAnomaly[] = []
  for (const row of rows) {
    if (row.outcome !== 'anomaly' || !REVIEWER_CODES.has(row.code)) continue
    const code = row.code as 'reviewer_finding' | 'reviewer_failed'
    const id = { code, refKey: row.ref, contentHash: row.contentHash }
    anomalies.push({
      code,
      gate: null,
      class: 'data',
      ref: refOfRow(row),
      refKey: row.ref,
      contentHash: row.contentHash,
      place: placeOfRow(row.detail),
      slot: typeof row.detail.slot === 'string' ? row.detail.slot : null,
      resolution: RED_TEAM_ANOMALIES[code].resolution,
      status: statusOf(id, ctx.acceptances, ctx.decisions),
      detail: row.detail,
    })
  }
  if (ctx.recipe.redTeamRules.length === 0) return { anomalies, tally: null }
  const count = (code: string, outcome: RedTeamRow['outcome']) => {
    const r = rows.find((x) => x.code === code && x.outcome === outcome)
    const c = r?.detail.count
    return typeof c === 'number' && Number.isInteger(c) && c > 0 ? c : 0
  }
  const reviewed = rows.some((r) => r.code === 'reviewer' && r.outcome === 'checked')
  if (!reviewed && !anomalies.some((a) => a.code === 'reviewer_failed')) {
    const ref: RedTeamRef = { element: 'check', check: 'reviewer' }
    anomalies.push({
      code: 'reviewer_failed',
      gate: null,
      class: 'data',
      ref,
      refKey: refKeyOf(ref),
      contentHash: canonicalHash({ reviewer: 'failed' }),
      place: {},
      slot: null,
      resolution: 'none',
      status: 'open',
      detail: {},
    })
  }
  return {
    anomalies,
    tally: {
      checks: ctx.recipe.redTeamRules.length,
      admitted: anomalies.length,
      discarded: count('reviewer_finding', 'discarded'),
      failed: !reviewed,
    },
  }
}

/** One anomaly per source the draft cites that was removed at the source since. */
function removedAnomalies(
  doc: InternalDocument,
  removed: RecheckInput['removed'],
  ctx: RedTeamContext,
): RedTeamAnomaly[] {
  const bySource = new Map<string, { label: string; notes: number[] }>()
  for (const note of doc.sourceNotes) {
    const key =
      note.ref.kind === 'evidence' && removed.evidence.has(note.ref.evidenceId)
        ? `evidence:${note.ref.evidenceId}`
        : note.ref.kind === 'fact' && removed.facts.has(note.ref.factId)
          ? `fact:${note.ref.factId}`
          : null
    if (key === null) continue
    const entry = bySource.get(key) ?? { label: note.label, notes: [] }
    entry.notes.push(note.n)
    bySource.set(key, entry)
  }
  return [...bySource].map(([key, { label, notes }]) => {
    const ref: RedTeamRef = { element: 'source', source: key }
    const refKey = refKeyOf(ref)
    const contentHash = canonicalHash({ key, removed: true })
    return {
      code: 'source_removed',
      gate: 1,
      class: 'data',
      ref,
      refKey,
      contentHash,
      place: {},
      slot: null,
      resolution: RED_TEAM_ANOMALIES.source_removed.resolution,
      status: statusOf({ code: 'source_removed', refKey, contentHash }, ctx.acceptances, []),
      detail: { label, notes },
    }
  })
}

/** The anomaly of a recipe, or of its settings in the project, changed since the snapshot. */
function recipeChangedAnomaly(
  changed: NonNullable<RecheckInput['recipeChanged']>,
  ctx: RedTeamContext,
): RedTeamAnomaly {
  const ref: RedTeamRef = { element: 'check', check: 'recipe' }
  const refKey = refKeyOf(ref)
  const contentHash = canonicalHash(changed)
  return {
    code: 'recipe_changed',
    gate: null,
    class: 'data',
    ref,
    refKey,
    contentHash,
    place: {},
    slot: null,
    resolution: RED_TEAM_ANOMALIES.recipe_changed.resolution,
    status: statusOf({ code: 'recipe_changed', refKey, contentHash }, ctx.acceptances, []),
    detail: {},
  }
}

const rowKey = (outcome: string, code: string, ref: string, hash: string) =>
  JSON.stringify([outcome, code, ref, hash])

/**
 * The red-team of a stored draft judged again by the code, at the time given in the context:
 * the common gates and the checks of the recipe on the draft as it is, the client version
 * projected again with the acceptances of the PM, the sources removed since, and the findings
 * of the model reviewer as stored. Nothing of the stored rows lowers what is found.
 */
export function recheckDraft(input: RecheckInput): Recheck {
  const { reviewer: _ignored, ...ctx } = input.context
  const result = runRedTeam(input.document, ctx)
  const review = reviewerOf(input.storedRows, ctx)
  const anomalies = [
    ...(input.recipeChanged === undefined ? [] : [recipeChangedAnomaly(input.recipeChanged, ctx)]),
    ...removedAnomalies(input.document, input.removed, ctx),
    ...result.anomalies,
    ...review.anomalies,
  ]
  const full: RedTeamResult = { ...result, anomalies, reviewer: review.tally }
  const stored = new Map(
    input.storedRows.map((r) => [rowKey(r.outcome, r.code, r.ref, r.contentHash), r.id]),
  )
  const checkOf = (outcome: string, f: { code: string; refKey: string; contentHash: string }) =>
    stored.get(rowKey(outcome, f.code, f.refKey, f.contentHash)) ?? null
  const rechecked: RecheckedAnomaly[] = anomalies.map((a) => ({
    ...a,
    checkId: checkOf('anomaly', a),
  }))
  const warnings: RecheckedWarning[] = full.warnings.map((w) => ({
    ...w,
    checkId: checkOf('warning', w),
    confirmed: w.requiresConfirmation ? isConfirmed(w, input.confirmations) : true,
  }))
  const counts: Record<ApprovalBlocker, number> = {
    finding_after_draft: 0,
    anomaly_open: 0,
    decision_missing: 0,
    story_points_unconfirmed: 0,
  }
  for (const a of rechecked) {
    if (a.status !== 'open') continue
    if (a.checkId === null) counts.finding_after_draft++
    else if (a.resolution === 'decision') counts.decision_missing++
    else counts.anomaly_open++
  }
  for (const w of warnings) {
    if (w.confirmed) continue
    if (w.checkId === null) counts.finding_after_draft++
    else counts.story_points_unconfirmed++
  }
  return {
    anomalies: rechecked,
    warnings,
    summary: summarizeRedTeam(redTeamRows(full), ctx.acceptances, ctx.decisions),
    blockers: APPROVAL_BLOCKERS.filter((b) => counts[b] > 0).map((code) => ({
      code,
      count: counts[code],
    })),
    skeletonHash: full.skeletonHash,
    dataHash: full.dataHash,
  }
}

/**
 * The findings of a recheck that have no stored row yet (found after the draft): the rows to
 * store on the revision, so the PM accepts, decides or confirms them one at a time like the
 * others. What may be accepted still depends on the code alone: credentials and secrets never.
 */
export function lateFindingRows(recheck: Recheck): RedTeamRow[] {
  const placeDetail = (p: RedTeamPlace): DetailObject => ({ ...p })
  return [
    ...recheck.anomalies
      .filter((a) => a.checkId === null)
      .map(
        (a): RedTeamRow => ({
          code: a.code,
          class: a.class,
          outcome: 'anomaly',
          acceptable: a.resolution === 'acceptance',
          ref: a.refKey,
          contentHash: a.contentHash,
          detail: { ...a.detail, gate: a.gate, slot: a.slot, place: placeDetail(a.place) },
        }),
      ),
    ...recheck.warnings
      .filter((w) => w.checkId === null)
      .map(
        (w): RedTeamRow => ({
          code: w.code,
          class: 'data',
          outcome: 'warning',
          acceptable: false,
          ref: w.refKey,
          contentHash: w.contentHash,
          detail: {
            ...w.detail,
            gate: w.gate,
            place: placeDetail(w.place),
            requiresConfirmation: w.requiresConfirmation,
          },
        }),
      ),
  ]
}

/** Most decisions shown to the PM at a time: anomalies, contradictions, changed values. */
export const MAX_DECISIONS_SHOWN = 5

export type PendingDecision =
  | { kind: 'accept'; anomaly: RecheckedAnomaly }
  | { kind: 'decide'; anomaly: RecheckedAnomaly }
  | { kind: 'confirm'; warning: RecheckedWarning }

/**
 * What the PM may still decide on the draft, at most `MAX_DECISIONS_SHOWN` at a time, in the
 * order of the red-team: anomalies to accept, contradictions and changed values to decide, story
 * points to confirm. Only findings with a stored row: the others need a new draft.
 */
export function pendingDecisions(recheck: Recheck, limit = MAX_DECISIONS_SHOWN): PendingDecision[] {
  const out: PendingDecision[] = []
  for (const a of recheck.anomalies) {
    if (a.status !== 'open' || a.checkId === null) continue
    if (a.resolution === 'acceptance') out.push({ kind: 'accept', anomaly: a })
    if (a.resolution === 'decision') out.push({ kind: 'decide', anomaly: a })
  }
  for (const w of recheck.warnings) {
    if (!w.confirmed && w.checkId !== null) out.push({ kind: 'confirm', warning: w })
  }
  return out.slice(0, Math.max(0, Math.min(limit, MAX_DECISIONS_SHOWN)))
}

// «Chiedi modifica» on an old snapshot --------------------------------------------------------

/**
 * Whether the snapshot of a run is too old for a request of the PM: past the warning threshold
 * of the project (at most 24 hours), the PM regenerates the draft instead.
 */
/** The age past which a snapshot is too old for a request of the PM, in hours. */
export function snapshotLimitHours(thresholds: FreshnessThresholds = DEFAULT_FRESHNESS): number {
  return tightenFreshness(thresholds).warnAfterHours
}

export function snapshotTooOld(
  referenceTime: string,
  now: Date,
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS,
): boolean {
  const limit = tightenFreshness(thresholds).warnAfterHours * 3_600_000
  const at = Date.parse(referenceTime)
  return !Number.isFinite(at) || now.getTime() - at > limit
}

// States and actions ----------------------------------------------------------------------------

export const APPROVAL_STATUSES = ['approving', 'approved', 'render_failed'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const REVISION_STATES = [
  'in_preparation',
  'in_review',
  'approving',
  'approved',
  'approved_with_accepted_anomalies',
  'render_failed',
  'superseded',
  'failed',
  'discarded',
] as const
export type RevisionState = (typeof REVISION_STATES)[number]

/**
 * The state of a revision: its approval attempts first (an approval only moves forward), then
 * its run and whether a later revision superseded it.
 */
export function revisionStateOf(r: {
  runStatus: RunStatus
  latest: boolean
  attempts: readonly ApprovalStatus[]
  /** Anomalies accepted on the revision as approved. */
  accepted: number
}): RevisionState {
  const last = r.attempts.at(-1)
  if (last === 'approving') return 'approving'
  if (last === 'render_failed') return 'render_failed'
  if (last === 'approved') return r.accepted > 0 ? 'approved_with_accepted_anomalies' : 'approved'
  if (r.runStatus === 'discarded') return 'discarded'
  if (!r.latest) return 'superseded'
  if (r.runStatus === 'ready') return 'in_review'
  if (r.runStatus === 'failed') return 'failed'
  return 'in_preparation'
}

export const REVISION_ACTIONS = [
  'approve',
  'accept',
  'decide',
  'confirm_story_points',
  'request_change',
  'discard',
  'retry_render',
  'download',
  'show_diff',
] as const
export type RevisionAction = (typeof REVISION_ACTIONS)[number]

export type ActionReason =
  | ApprovalBlocker
  | 'not_project_member'
  | 'not_project_pm'
  | 'run_in_preparation'
  | 'run_failed'
  | 'run_discarded'
  | 'revision_superseded'
  | 'approval_in_progress'
  | 'already_approved'
  | 'nothing_to_accept'
  | 'nothing_to_decide'
  | 'nothing_to_confirm'
  | 'snapshot_too_old'
  | 'no_text_slots'
  | 'render_not_failed'
  /** After a failed render something new stops the approval: only a new run can be approved. */
  | 'retry_needs_new_run'
  | 'not_approved'
  | 'first_revision'

export interface ActionAvailability {
  available: boolean
  /** Why not, in a code with a text for the PM; null when available. */
  reason: ActionReason | null
}

export type AvailableActions = Readonly<Record<RevisionAction, ActionAvailability>>

/** What the server knows of a revision, recomputed, to say which actions the PM has. */
export interface RevisionFacts {
  state: RevisionState
  /** The number of the revision in its run. */
  n: number
  blockers: Recheck['blockers']
  /** Open stored anomalies the PM may accept. */
  acceptable: number
  /** Open stored contradictions and changed values the PM may decide. */
  decidable: number
  /** Stored warnings still to confirm (story points). */
  confirmable: number
  /** Text slots the PM may ask to write again. */
  textSlots: number
  /** The snapshot is past the threshold for a request of the PM. */
  snapshotTooOld: boolean
  /** That threshold, in hours: the warning threshold of the project, at most 24. */
  snapshotLimitHours?: number
}

export type ActionUser = { role: 'pm' | 'viewer' | 'connector' | null }

const yes: ActionAvailability = Object.freeze({ available: true, reason: null })
const no = (reason: ActionReason): ActionAvailability => ({ available: false, reason })

/** Why a revision in this state is not under review; null when it is. */
function notInReview(state: RevisionState): ActionReason | null {
  switch (state) {
    case 'in_review':
      return null
    case 'in_preparation':
      return 'run_in_preparation'
    case 'failed':
      return 'run_failed'
    case 'discarded':
      return 'run_discarded'
    case 'superseded':
      return 'revision_superseded'
    case 'approving':
      return 'approval_in_progress'
    default:
      return 'already_approved'
  }
}

/**
 * Every action on a revision, available or not with the reason: the people of the project see
 * them all, only a PM of the project acts, and nothing is offered that the server would refuse.
 */
export function availableActions(revision: RevisionFacts, user: ActionUser): AvailableActions {
  const member = user.role === 'pm' || user.role === 'viewer'
  if (!member) {
    return Object.fromEntries(
      REVISION_ACTIONS.map((a) => [a, no('not_project_member')]),
    ) as unknown as AvailableActions
  }
  const pm = user.role === 'pm'
  const review = notInReview(revision.state)
  const approved =
    revision.state === 'approved' || revision.state === 'approved_with_accepted_anomalies'
  const inReview = (more: () => ActionReason | null): ActionAvailability => {
    if (!pm) return no('not_project_pm')
    if (review !== null) return no(review)
    const reason = more()
    return reason === null ? yes : no(reason)
  }
  const discard = (): ActionAvailability => {
    if (!pm) return no('not_project_pm')
    switch (revision.state) {
      case 'approving':
        return no('approval_in_progress')
      case 'approved':
      case 'approved_with_accepted_anomalies':
        return no('already_approved')
      case 'discarded':
        return no('run_discarded')
      case 'superseded':
        return no('revision_superseded')
      default:
        return yes
    }
  }
  return {
    approve: inReview(() => revision.blockers[0]?.code ?? null),
    accept: inReview(() => (revision.acceptable > 0 ? null : 'nothing_to_accept')),
    decide: inReview(() => (revision.decidable > 0 ? null : 'nothing_to_decide')),
    confirm_story_points: inReview(() => (revision.confirmable > 0 ? null : 'nothing_to_confirm')),
    request_change: inReview(() =>
      revision.snapshotTooOld
        ? 'snapshot_too_old'
        : revision.textSlots > 0
          ? null
          : 'no_text_slots',
    ),
    discard: discard(),
    retry_render: !pm
      ? no('not_project_pm')
      : revision.state !== 'render_failed'
        ? no('render_not_failed')
        : revision.blockers.length > 0
          ? no('retry_needs_new_run')
          : yes,
    download: approved ? yes : no('not_approved'),
    show_diff: revision.n > 1 ? yes : no('first_revision'),
  }
}

export type ApprovalTextKey = `reason_${ActionReason}` | `state_${RevisionState}`

/**
 * Why an action is not available, in the words of a PM; `hours` is the threshold of the snapshot
 * of the run (`RevisionFacts.snapshotLimitHours`), 24 when not given.
 */
export function actionReasonText(
  reason: ActionReason,
  lang: Lang,
  params: { hours?: number } = {},
): string {
  return recipeText(
    'approval',
    `reason_${reason}`,
    { hours: params.hours ?? DEFAULT_FRESHNESS.warnAfterHours },
    lang,
  )
}

/** The state of a revision, in the words of a PM. */
export function revisionStateText(state: RevisionState, lang: Lang): string {
  return recipeText('approval', `state_${state}`, {}, lang)
}

/** The acceptances, decisions and confirmations a server reads for a run, together. */
export interface RunJudgements {
  acceptances: readonly Acceptance[]
  decisions: readonly PmDecision[]
  confirmations: readonly StoryPointsConfirmation[]
}
