import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  acceptAnomaly,
  actionReasonText,
  availableActions,
  confirmStoryPoints,
  type InternalDocument,
  lateFindingRows,
  MAX_DECISIONS_SHOWN,
  pendingDecisions,
  REVISION_ACTIONS,
  REVISION_STATES,
  type RecheckedAnomaly,
  type RedTeamContext,
  type RevisionFacts,
  recheckDraft,
  redTeamRows,
  revisionStateOf,
  revisionStateText,
  type StoredCheck,
  type StoryPointsConfirmation,
  snapshotLimitHours,
  snapshotTooOld,
} from '../src/recipe/index.ts'
import { audienceContext, internalDocument } from './support/client-version.ts'
import {
  cleanDraft,
  redTeam,
  redTeamContext,
  segment,
  summaryText,
  verifiedSlots,
} from './support/red-team.ts'

// The approval judged by the code: the red-team of the stored draft computed again, what still
// stops the approval, the state of the revision and the actions with their reasons.

const AT = '2026-11-06T10:00:00.000Z'
const REASON = 'Il cliente ha chiesto di vedere il margine del mese.'

/** The rows the job stored for a draft, each with an id, and the review of the model. */
function storedRowsOf(doc: InternalDocument, ctx: RedTeamContext): StoredCheck[] {
  const rows = redTeamRows(redTeam(doc, ctx))
  rows.push({
    code: 'reviewer',
    class: 'data',
    outcome: 'checked',
    acceptable: false,
    ref: '',
    contentHash: '',
    detail: { count: 1 },
  })
  return rows.map((r, i) => ({ ...r, id: `check-${i + 1}` }))
}

function recheck(
  doc: InternalDocument,
  over: {
    ctx?: Partial<RedTeamContext>
    stored?: StoredCheck[]
    confirmations?: StoryPointsConfirmation[]
    removed?: { evidence?: string[]; facts?: string[] }
    recipeChanged?: { recipeHash: string; settingsHash: string | null }
  } = {},
) {
  const ctx = redTeamContext({
    client: { audience: audienceContext() },
    slotVerifications: verifiedSlots(doc),
    ...over.ctx,
  })
  return recheckDraft({
    document: doc,
    context: ctx,
    storedRows: over.stored ?? storedRowsOf(doc, ctx),
    removed: {
      evidence: new Set(over.removed?.evidence ?? []),
      facts: new Set(over.removed?.facts ?? []),
    },
    confirmations: over.confirmations ?? [],
    ...(over.recipeChanged === undefined ? {} : { recipeChanged: over.recipeChanged }),
  })
}

const facts = (over: Partial<RevisionFacts> = {}): RevisionFacts => ({
  state: 'in_review',
  n: 1,
  blockers: [],
  acceptable: 0,
  decidable: 0,
  confirmable: 0,
  textSlots: 1,
  snapshotTooOld: false,
  ...over,
})

describe('the red-team judged again for the approval', () => {
  it('finds the internal margin in the client version and the story points to confirm', () => {
    const r = recheck(internalDocument())
    const margin = r.anomalies.find((a) => a.code === 'internal_data_in_client')
    expect(margin).toMatchObject({ status: 'open', resolution: 'acceptance' })
    expect(margin?.checkId).toMatch(/^check-/)
    expect(r.warnings.find((w) => w.code === 'story_points_in_client')).toMatchObject({
      confirmed: false,
    })
    expect(r.blockers.map((b) => b.code)).toEqual(['anomaly_open', 'story_points_unconfirmed'])
  })

  it('lets the PM accept an internal-data anomaly in a client version', () => {
    const doc = internalDocument()
    const first = recheck(doc)
    const margin = first.anomalies.find((a) => a.code === 'internal_data_in_client')
    if (!margin) throw new Error('the sample draft has a margin for the client')
    const accepted = acceptAnomaly(margin, { reason: REASON, by: 'pm', at: AT })
    if (!accepted.ok) throw new Error(`refused: ${accepted.refusal}`)
    const after = recheck(doc, { ctx: { acceptances: [accepted.acceptance] } })
    expect(after.anomalies.find((a) => a.code === 'internal_data_in_client')?.status).toBe(
      'accepted',
    )
    expect(after.summary.accepted).toBe(1)
    const open = (r: typeof first) => r.blockers.find((b) => b.code === 'anomaly_open')?.count ?? 0
    expect(open(after)).toBe(open(first) - 1)
  })

  it('requires the explicit story-points confirmation before approval', () => {
    const doc = cleanDraft()
    const r = recheck(doc)
    expect(r.blockers).toEqual([{ code: 'story_points_unconfirmed', count: 1 }])
    const warning = r.warnings.find((w) => w.code === 'story_points_in_client')
    if (!warning) throw new Error('the sample draft shows story points to the client')
    expect(confirmStoryPoints(warning, { reason: 'ok', by: 'pm', at: AT })).toEqual({
      ok: false,
      refusal: 'reason_too_short',
    })
    const margin = recheck(internalDocument()).anomalies[0]
    expect(
      confirmStoryPoints(margin as never, {
        reason: 'Il cliente li usa per pianificare.',
        by: 'pm',
        at: AT,
      }),
    ).toEqual({ ok: false, refusal: 'not_confirmable' })
    const confirmed = confirmStoryPoints(warning, {
      reason: 'Il cliente usa gli story point per pianificare gli sprint.',
      by: 'pm',
      at: AT,
    })
    if (!confirmed.ok) throw new Error('confirmation refused')
    expect(recheck(doc, { confirmations: [confirmed.confirmation] }).blockers).toEqual([])
  })

  it('an acceptance no longer applies when the content changed', () => {
    const doc = internalDocument()
    const margin = recheck(doc).anomalies.find((a) => a.code === 'internal_data_in_client')
    if (!margin) throw new Error('the sample draft has a margin for the client')
    const accepted = acceptAnomaly(margin, { reason: REASON, by: 'pm', at: AT })
    if (!accepted.ok) throw new Error('acceptance refused')
    // The margin changes in the next revision: the acceptance was for the old value.
    const changed = structuredClone(doc)
    const text = JSON.stringify(changed).replace('al 18% sul venduto', 'al 21% sul venduto')
    const next = JSON.parse(text) as InternalDocument
    expect(text).toContain('al 21% sul venduto')
    const after = recheck(next, { ctx: { acceptances: [accepted.acceptance] } })
    const again = after.anomalies.find((a) => a.code === 'internal_data_in_client')
    expect(again?.contentHash).not.toBe(margin.contentHash)
    expect(again?.status).toBe('open')
  })

  it('never takes the outcome of the stored checks: a clean stored red-team does not hide one', () => {
    const doc = internalDocument()
    // Stored rows claiming nothing was found: only tallies and the review.
    const stored = storedRowsOf(cleanDraft(), redTeamContext()).filter(
      (r) => r.outcome === 'checked',
    )
    const r = recheck(doc, { stored })
    const margin = r.anomalies.find((a) => a.code === 'internal_data_in_client')
    expect(margin).toMatchObject({ status: 'open', checkId: null })
    expect(r.blockers[0]).toEqual({ code: 'finding_after_draft', count: expect.any(Number) })
  })

  it('counts a review that is not stored as a review that did not happen', () => {
    const doc = cleanDraft()
    const ctx = redTeamContext({ slotVerifications: verifiedSlots(doc) })
    const stored = storedRowsOf(doc, ctx).filter((r) => r.code !== 'reviewer')
    const r = recheck(doc, { stored })
    expect(r.anomalies.find((a) => a.code === 'reviewer_failed')).toMatchObject({
      status: 'open',
      resolution: 'none',
    })
  })

  it('keeps the stored findings of the model reviewer, which only the model gives', () => {
    const doc = cleanDraft()
    const ctx = redTeamContext({ slotVerifications: verifiedSlots(doc) })
    const stored = storedRowsOf(doc, ctx)
    stored.push({
      id: 'check-reviewer',
      code: 'reviewer_finding',
      class: 'data',
      outcome: 'anomaly',
      acceptable: true,
      ref: '{"element":"check","check":"reviewer"}',
      contentHash: `sha256:${'d'.repeat(64)}`,
      detail: { message: 'Un blocco attivo non è citato.' },
    })
    const r = recheck(doc, { stored })
    expect(r.anomalies.find((a) => a.code === 'reviewer_finding')).toMatchObject({
      checkId: 'check-reviewer',
      status: 'open',
    })
  })

  it('judges the age of the sources at the time of the approval', () => {
    const doc = cleanDraft()
    const later = new Date(Date.parse('2026-11-06T09:30:00.000Z') + 96 * 3_600_000)
    const ctx = redTeamContext({ slotVerifications: verifiedSlots(doc) })
    const stored = storedRowsOf(doc, ctx)
    const r = recheck(doc, {
      stored,
      ctx: { freshness: { ...ctx.freshness, now: later.toISOString() } },
    })
    expect(r.anomalies.find((a) => a.code === 'stale_source')).toMatchObject({ checkId: null })
    expect(r.blockers.map((b) => b.code)).toContain('finding_after_draft')
  })

  it('raises a new anomaly for a source removed since the draft', () => {
    const r = recheck(cleanDraft(), { removed: { evidence: ['ev-dwsi'] } })
    const removed = r.anomalies.find((a) => a.code === 'source_removed')
    expect(removed).toMatchObject({
      ref: { element: 'source', source: 'evidence:ev-dwsi' },
      resolution: 'acceptance',
      checkId: null,
    })
    expect(r.blockers[0]?.code).toBe('finding_after_draft')
  })

  it('a source removed after the draft becomes an acceptable anomaly, and accepting it lets the approval go', () => {
    const doc = cleanDraft()
    const ctx = redTeamContext({ slotVerifications: verifiedSlots(doc) })
    const stored = storedRowsOf(doc, ctx)
    const sp = stored.find((r) => r.code === 'story_points_in_client')
    if (!sp) throw new Error('the clean draft shows story points to the client')
    const confirmed = confirmStoryPoints(
      { code: sp.code, refKey: sp.ref, contentHash: sp.contentHash },
      { reason: 'Il cliente usa gli story point per pianificare.', by: 'pm', at: AT },
    )
    if (!confirmed.ok) throw new Error('confirmation refused')
    const removed = { evidence: ['ev-dwsi'] }
    const first = recheck(doc, { stored, removed, confirmations: [confirmed.confirmation] })
    const late = lateFindingRows(first)
    expect(late.map((r) => [r.code, r.outcome, r.acceptable])).toEqual([
      ['source_removed', 'anomaly', true],
    ])
    // Stored on the revision, the late finding is one more anomaly the PM accepts.
    const withLate = [...stored, ...late.map((r, i) => ({ ...r, id: `late-${i + 1}` }))]
    const second = recheck(doc, {
      stored: withLate,
      removed,
      confirmations: [confirmed.confirmation],
    })
    const anomaly = second.anomalies.find((a) => a.code === 'source_removed')
    expect(anomaly).toMatchObject({ checkId: 'late-1', status: 'open' })
    expect(second.blockers).toEqual([{ code: 'anomaly_open', count: 1 }])
    expect(lateFindingRows(second)).toEqual([])
    const accepted = acceptAnomaly(anomaly as RecheckedAnomaly, {
      reason: REASON,
      by: 'pm',
      at: AT,
    })
    if (!accepted.ok) throw new Error('acceptance refused')
    const third = recheck(doc, {
      stored: withLate,
      removed,
      confirmations: [confirmed.confirmation],
      ctx: { acceptances: [accepted.acceptance] },
    })
    expect(third.blockers).toEqual([])
  })

  it('never makes a credential found after the draft acceptable', () => {
    const doc = cleanDraft()
    const ctx = redTeamContext({ slotVerifications: verifiedSlots(doc) })
    const stored = storedRowsOf(doc, ctx)
    // The credential appears only in the draft judged again: stored, it stays not acceptable.
    const credential = `Accesso con pass${'word'}: ${randomBytes(6).toString('hex')}!7`
    summaryText(doc).segments.push(segment(credential, [2]))
    const late = lateFindingRows(recheck(doc, { stored }))
    const row = late.find((r) => r.code === 'credential_in_text')
    expect(row).toMatchObject({ outcome: 'anomaly', acceptable: false })
    expect(
      acceptAnomaly(
        { code: 'credential_in_text', refKey: row?.ref ?? '', contentHash: row?.contentHash ?? '' },
        { reason: REASON, by: 'pm', at: AT },
      ),
    ).toEqual({ ok: false, refusal: 'not_acceptable' })
  })

  it('raises an acceptable anomaly when the recipe or its settings changed since the run', () => {
    const changed = { recipeHash: `sha256:${'a'.repeat(64)}`, settingsHash: null }
    const r = recheck(cleanDraft(), { recipeChanged: changed })
    expect(r.anomalies[0]).toMatchObject({
      code: 'recipe_changed',
      resolution: 'acceptance',
      checkId: null,
    })
    // Changed again, it is a new finding: an acceptance of the first does not hold.
    const again = recheck(cleanDraft(), {
      recipeChanged: { ...changed, settingsHash: `sha256:${'b'.repeat(64)}` },
    })
    expect(again.anomalies[0]?.contentHash).not.toBe(r.anomalies[0]?.contentHash)
  })

  it('shows at most five decisions at a time', () => {
    const r = recheck(internalDocument())
    const margin = r.anomalies.find((a) => a.code === 'internal_data_in_client')
    const many = { ...r, anomalies: Array.from({ length: 9 }, () => margin) }
    expect(pendingDecisions(many as typeof r)).toHaveLength(MAX_DECISIONS_SHOWN)
    expect(pendingDecisions(many as typeof r, 50)).toHaveLength(MAX_DECISIONS_SHOWN)
  })
})

describe('the state of a revision', () => {
  it('moves forward with its approval attempts', () => {
    const base = { runStatus: 'ready' as const, latest: true, accepted: 0 }
    expect(revisionStateOf({ ...base, attempts: [] })).toBe('in_review')
    expect(revisionStateOf({ ...base, attempts: ['approving'] })).toBe('approving')
    expect(revisionStateOf({ ...base, attempts: ['approved'] })).toBe('approved')
    expect(revisionStateOf({ ...base, accepted: 2, attempts: ['approved'] })).toBe(
      'approved_with_accepted_anomalies',
    )
    expect(revisionStateOf({ ...base, attempts: ['render_failed'] })).toBe('render_failed')
    expect(revisionStateOf({ ...base, attempts: ['render_failed', 'approving'] })).toBe('approving')
    expect(revisionStateOf({ ...base, latest: false, attempts: [] })).toBe('superseded')
    expect(revisionStateOf({ ...base, runStatus: 'running', attempts: [] })).toBe('in_preparation')
    expect(revisionStateOf({ ...base, runStatus: 'discarded', attempts: [] })).toBe('discarded')
  })

  it('has a text for the PM for every state', () => {
    for (const s of REVISION_STATES) expect(revisionStateText(s, 'it')).not.toBe('')
  })
})

describe('the actions on a revision', () => {
  it('disables approve while an anomaly is open, with the reason', () => {
    const r = recheck(internalDocument())
    const actions = availableActions(
      facts({ blockers: r.blockers, acceptable: 1, confirmable: 1 }),
      { role: 'pm' },
    )
    expect(actions.approve).toEqual({ available: false, reason: 'anomaly_open' })
    expect(actionReasonText('anomaly_open', 'it')).toMatch(/anomalie aperte/)
    expect(actions.accept).toEqual({ available: true, reason: null })
    expect(actions.confirm_story_points.available).toBe(true)
    expect(actions.decide).toEqual({ available: false, reason: 'nothing_to_decide' })
    expect(availableActions(facts(), { role: 'pm' }).approve).toEqual({
      available: true,
      reason: null,
    })
  })

  it('a viewer cannot approve', () => {
    const actions = availableActions(facts(), { role: 'viewer' })
    expect(actions.approve).toEqual({ available: false, reason: 'not_project_pm' })
    expect(actions.accept.reason).toBe('not_project_pm')
    expect(actions.request_change.reason).toBe('not_project_pm')
    // Reading stays: the differences and, once approved, the files.
    expect(actions.show_diff.reason).toBe('first_revision')
    expect(
      availableActions(facts({ state: 'approved' }), { role: 'viewer' }).download.available,
    ).toBe(true)
    const stranger = availableActions(facts(), { role: null })
    for (const a of REVISION_ACTIONS) expect(stranger[a].reason).toBe('not_project_member')
  })

  it('refuses every review action on a superseded or approved revision', () => {
    const superseded = availableActions(facts({ state: 'superseded' }), { role: 'pm' })
    expect(superseded.approve.reason).toBe('revision_superseded')
    expect(superseded.accept.reason).toBe('revision_superseded')
    const approved = availableActions(facts({ state: 'approved' }), { role: 'pm' })
    expect(approved.approve.reason).toBe('already_approved')
    expect(approved.request_change.reason).toBe('already_approved')
    expect(approved.discard.reason).toBe('already_approved')
    expect(approved.retry_render.reason).toBe('render_not_failed')
    const failed = availableActions(facts({ state: 'render_failed' }), { role: 'pm' })
    expect(failed.retry_render.available).toBe(true)
    const late = availableActions(
      facts({ state: 'render_failed', blockers: [{ code: 'finding_after_draft', count: 1 }] }),
      { role: 'pm' },
    )
    expect(late.retry_render).toEqual({ available: false, reason: 'retry_needs_new_run' })
    expect(actionReasonText('retry_needs_new_run', 'it')).toMatch(/nuova esecuzione/)
    expect(failed.download.reason).toBe('not_approved')
  })

  it('proposes to regenerate instead of a change on a snapshot older than a day', () => {
    const actions = availableActions(facts({ snapshotTooOld: true }), { role: 'pm' })
    expect(actions.request_change).toEqual({ available: false, reason: 'snapshot_too_old' })
    // The text says the threshold of the project, not a fixed one.
    expect(actionReasonText('snapshot_too_old', 'it', { hours: 12 })).toContain('12 ore')
    expect(snapshotLimitHours({ warnAfterHours: 12, stopAfterHours: 48 })).toBe(12)
    const at = '2026-11-05T09:00:00.000Z'
    expect(snapshotTooOld(at, new Date('2026-11-06T08:59:00.000Z'))).toBe(false)
    expect(snapshotTooOld(at, new Date('2026-11-06T09:01:00.000Z'))).toBe(true)
    // A stricter project threshold shortens it, never lengthens it.
    expect(
      snapshotTooOld(at, new Date('2026-11-05T22:00:00.000Z'), {
        warnAfterHours: 12,
        stopAfterHours: 48,
      }),
    ).toBe(true)
  })

  it('has a text for the PM for every reason', () => {
    const reasons = new Set<string>()
    for (const state of REVISION_STATES) {
      for (const role of ['pm', 'viewer', null] as const) {
        const actions = availableActions(
          facts({
            state,
            blockers: [{ code: 'decision_missing', count: 1 }],
            textSlots: 0,
          }),
          { role },
        )
        for (const a of REVISION_ACTIONS) {
          const reason = actions[a].reason
          if (reason !== null) reasons.add(reason)
        }
      }
    }
    for (const r of reasons) expect(actionReasonText(r as never, 'it')).not.toBe('')
    expect(reasons.size).toBeGreaterThan(10)
  })
})

describe('«Accetta così» before the approval', () => {
  it('refuses to accept a credential anomaly', () => {
    const at = { by: 'pm', at: AT, reason: 'La chiave è di prova e non funziona più da mesi.' }
    for (const code of ['credential_in_text', 'secret_in_text']) {
      expect(acceptAnomaly({ code, refKey: '{}', contentHash: 'sha256:x' }, at)).toEqual({
        ok: false,
        refusal: 'not_acceptable',
      })
    }
  })

  it('accepts one anomaly at a time with a reason of at least 20 characters', () => {
    const margin = recheck(internalDocument()).anomalies.find(
      (a) => a.code === 'internal_data_in_client',
    )
    if (!margin) throw new Error('the sample draft has a margin for the client')
    expect(acceptAnomaly(margin, { reason: 'Va bene così.', by: 'pm', at: AT })).toEqual({
      ok: false,
      refusal: 'reason_too_short',
    })
    const ok = acceptAnomaly(margin, { reason: REASON, by: 'pm', at: AT })
    expect(ok).toMatchObject({ ok: true, acceptance: { refKey: margin.refKey } })
  })
})
