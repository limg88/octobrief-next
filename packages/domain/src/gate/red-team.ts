import type { Lang } from '../language/index.ts'
import { CHECK_CLASS, type CheckClass, type CheckKind } from '../recipe/checks.ts'
import { type BlockRemark, blockRemarkText } from '../recipe/gathered.ts'
import { canonicalHash } from '../recipe/hash.ts'
import { recipeText } from '../recipe/messages/index.ts'
import { SLOT_LIMITS } from '../recipe/slot-answer.ts'
import type { SuspiciousHit } from '../suspicious.ts'
import type { Acceptance } from './acceptance.ts'
import { type AudienceAnomaly, audienceFindingText, type InternalDocument } from './audience.ts'
import {
  type CommonGatesContext,
  type GateTally,
  runCommonGates,
  suspiciousWarnings,
} from './common-gates.ts'
import { type PmDecision, statusOf } from './decisions.ts'
import { dataHash, skeletonHash } from './fingerprints.ts'
import { runRecipeChecks } from './recipe-checks.ts'
import {
  type AnomalyStatus,
  type DetailObject,
  type DetailValue,
  isRedTeamAnomalyCode,
  isRedTeamWarningCode,
  RED_TEAM_ANOMALIES,
  RED_TEAM_WARNINGS,
  type RedTeamAnomaly,
  type RedTeamPlace,
  type RedTeamRef,
  type RedTeamWarning,
  refKeyOf,
} from './red-team-model.ts'
import { admitReviewerFindings } from './reviewer.ts'

// The red-team of a draft: the ten common gates in their fixed order, then the checks of the
// recipe, then the findings of the model reviewer; the suspicious instructions of the evidence
// used as warnings. The outcome is «N verifiche, M anomalie» with the warnings counted apart,
// and the server always recomputes it from the stored rows: classes, acceptability and status
// come from the codes and from what the PM did, never from what a row says of itself.

export interface RedTeamContext extends CommonGatesContext {
  /** The suspicious instructions found in each piece of evidence, by id. */
  suspicious: Readonly<Record<string, readonly SuspiciousHit[]>>
  /** The answer of the model reviewer (a list of findings); absent when it did not run. */
  reviewer?: { findings: unknown }
  /** What the gathering said of how each data block was read, by block id. */
  remarks?: Readonly<Record<string, readonly BlockRemark[]>>
}

/**
 * The tables and lists of the draft longer than the reviewer reads, when the recipe has rules
 * for it: its checks there are on a sample of rows, and the PM is told, never a silent cut.
 */
export function reviewerSampleWarnings(
  doc: InternalDocument,
  ctx: RedTeamContext,
): RedTeamWarning[] {
  if (ctx.recipe.redTeamRules.length === 0) return []
  const rule = RED_TEAM_WARNINGS.reviewer_sample
  const out: RedTeamWarning[] = []
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'table' && block.kind !== 'list') continue
      const rows = block.kind === 'table' ? block.rows.length : block.items.length
      if (rows <= SLOT_LIMITS.rowsReviewed) continue
      const ref: RedTeamRef = { element: 'block', section: section.id, block: block.id }
      out.push({
        code: 'reviewer_sample',
        gate: rule.gate,
        ref,
        refKey: refKeyOf(ref),
        contentHash: canonicalHash({ rows, reviewed: SLOT_LIMITS.rowsReviewed }),
        place: { section: section.title, block: block.title ?? block.id },
        requiresConfirmation: rule.requiresConfirmation,
        detail: { rows: SLOT_LIMITS.rowsReviewed, of: rows },
      })
    }
  }
  return out
}

/**
 * What the gathering said of how the blocks of the draft were read, as warnings with their place:
 * never blocking, always in front of the PM (a sprint with no work item is not a count of zero).
 */
export function blockRemarkWarnings(
  doc: InternalDocument,
  remarks: Readonly<Record<string, readonly BlockRemark[]>>,
  lang: Lang,
): RedTeamWarning[] {
  const out: RedTeamWarning[] = []
  const rule = RED_TEAM_WARNINGS.block_remark
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      const list = Object.hasOwn(remarks, block.id) ? (remarks[block.id] ?? []) : []
      for (const remark of list) {
        // An optional filter the PM skipped: the start of the run already said what it does.
        if (remark.code === 'filter_dropped') continue
        const ref: RedTeamRef = { element: 'block', section: section.id, block: block.id }
        const title = 'title' in block && typeof block.title === 'string' ? block.title : block.id
        out.push({
          code: 'block_remark',
          gate: rule.gate,
          ref,
          refKey: refKeyOf(ref),
          contentHash: canonicalHash(remark),
          place: { section: section.title, block: title },
          requiresConfirmation: rule.requiresConfirmation,
          detail: { message: blockRemarkText(remark, lang), remark: remark.code },
        })
      }
    }
  }
  return out
}

export interface RedTeamResult {
  gates: GateTally[]
  /** Checks of the recipe run. */
  recipeChecks: number
  /** `failed`: the reviewer did not give a list of findings (an anomaly nobody accepts). */
  reviewer: { checks: number; admitted: number; discarded: number; failed: boolean } | null
  /** In the order of the gates, then the checks of the recipe, then the reviewer. */
  anomalies: RedTeamAnomaly[]
  warnings: RedTeamWarning[]
  skeletonHash: string
  dataHash: string
}

/** Runs the red-team on an internal draft. */
export function runRedTeam(doc: InternalDocument, ctx: RedTeamContext): RedTeamResult {
  const common = runCommonGates(doc, ctx)
  const checks = runRecipeChecks(doc, ctx)
  const withStatus = (a: RedTeamAnomaly): RedTeamAnomaly => ({
    ...a,
    status: statusOf(a, ctx.acceptances, ctx.decisions),
  })
  const anomalies = [...common.anomalies, ...checks.anomalies.map(withStatus)]
  let reviewer: RedTeamResult['reviewer'] = null
  if (ctx.reviewer !== undefined && !Array.isArray(ctx.reviewer.findings)) {
    // An answer that is not a list of findings is a review that did not happen, never «none».
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
    reviewer = { checks: ctx.recipe.redTeamRules.length, admitted: 0, discarded: 0, failed: true }
  } else if (ctx.reviewer !== undefined) {
    const admission = admitReviewerFindings(ctx.reviewer.findings, doc, ctx.recipe)
    anomalies.push(...admission.admitted.map(withStatus))
    reviewer = {
      checks: ctx.recipe.redTeamRules.length,
      admitted: admission.admitted.length,
      discarded: admission.discarded,
      failed: false,
    }
  }
  return {
    gates: common.gates,
    recipeChecks: checks.checks,
    reviewer,
    anomalies,
    warnings: [
      ...common.warnings,
      ...suspiciousWarnings(doc, ctx.suspicious),
      ...blockRemarkWarnings(doc, ctx.remarks ?? {}, ctx.lang),
      ...reviewerSampleWarnings(doc, ctx),
    ],
    skeletonHash: skeletonHash(doc),
    dataHash: dataHash(doc, ctx.lang, ctx.knownNames),
  }
}

// Stored rows ---------------------------------------------------------------------------------

export type StoredOutcome = 'checked' | 'anomaly' | 'warning' | 'discarded'

/** A row of `red_team_checks`: a tally of checks, an anomaly, a warning or discarded findings. */
export interface RedTeamRow {
  code: string
  class: string
  outcome: StoredOutcome
  acceptable: boolean
  /** The canonical key of the place (`refKeyOf`); empty for a tally. */
  ref: string
  contentHash: string
  detail: DetailObject
}

const placeDetail = (p: RedTeamPlace): DetailObject => ({ ...p })

/** The rows to store for a red-team: one tally per gate, then every anomaly and warning. */
export function redTeamRows(result: RedTeamResult): RedTeamRow[] {
  const rows: RedTeamRow[] = []
  for (const g of result.gates) {
    rows.push({
      code: `gate_${g.gate}`,
      class: g.class,
      outcome: 'checked',
      acceptable: false,
      ref: '',
      contentHash: '',
      detail: { count: g.checks },
    })
  }
  rows.push({
    code: 'recipe_checks',
    class: 'data',
    outcome: 'checked',
    acceptable: false,
    ref: '',
    contentHash: '',
    detail: { count: result.recipeChecks },
  })
  if (result.reviewer !== null) {
    rows.push({
      code: 'reviewer',
      class: 'data',
      outcome: 'checked',
      acceptable: false,
      ref: '',
      contentHash: '',
      detail: { count: result.reviewer.checks },
    })
    if (result.reviewer.discarded > 0) {
      rows.push({
        code: 'reviewer_finding',
        class: 'data',
        outcome: 'discarded',
        acceptable: false,
        ref: '',
        contentHash: '',
        detail: { count: result.reviewer.discarded },
      })
    }
  }
  for (const a of result.anomalies) {
    rows.push({
      code: a.code,
      class: a.class,
      outcome: 'anomaly',
      acceptable: a.resolution === 'acceptance',
      ref: a.refKey,
      contentHash: a.contentHash,
      detail: { ...a.detail, gate: a.gate, slot: a.slot, place: placeDetail(a.place) },
    })
  }
  for (const w of result.warnings) {
    rows.push({
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
    })
  }
  return rows
}

const CHECK_CODES = new Set(['recipe_check_failed', 'recipe_check_not_evaluable'])

/**
 * The class of a stored anomaly, from its code: a check of the recipe by its kind in the catalog,
 * the reviewer always data, an unknown code data (it never opens an automatic cycle).
 */
export function classOfRow(row: Pick<RedTeamRow, 'code' | 'detail'>): CheckClass {
  if (CHECK_CODES.has(row.code)) {
    const kind = row.detail.kind
    return typeof kind === 'string' && Object.hasOwn(CHECK_CLASS, kind)
      ? CHECK_CLASS[kind as CheckKind]
      : 'data'
  }
  if (isRedTeamAnomalyCode(row.code)) return RED_TEAM_ANOMALIES[row.code].class ?? 'data'
  return 'data'
}

/** An anomaly as recomputed from its stored row. */
export interface StoredAnomaly {
  code: string
  class: CheckClass
  refKey: string
  contentHash: string
  slot: string | null
  status: AnomalyStatus
}

/** The anomalies of the stored rows, with class and status recomputed. */
/**
 * The rows once each: a tally by its code, a finding by its code, place and content. A row stored
 * twice never counts twice.
 */
function uniqueRows(rows: readonly RedTeamRow[]): RedTeamRow[] {
  const seen = new Set<string>()
  return rows.filter((r) => {
    const key = JSON.stringify(
      r.outcome === 'checked' || r.outcome === 'discarded'
        ? [r.outcome, r.code]
        : [r.outcome, r.code, r.ref, r.contentHash],
    )
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function anomaliesOfRows(
  rows: readonly RedTeamRow[],
  acceptances: readonly Acceptance[],
  decisions: readonly PmDecision[],
): StoredAnomaly[] {
  return uniqueRows(rows)
    .filter((r) => r.outcome === 'anomaly')
    .map((r) => {
      const id = { code: r.code, refKey: r.ref, contentHash: r.contentHash }
      return {
        ...id,
        class: classOfRow(r),
        slot: typeof r.detail.slot === 'string' ? r.detail.slot : null,
        status: statusOf(id, acceptances, decisions),
      }
    })
}

export interface RedTeamSummary {
  /** N: the checks run. */
  checks: number
  /** M: the anomalies found, contradictions and changed declared values among them. */
  anomalies: number
  open: number
  accepted: number
  decided: number
  /** Open anomalies per class. */
  openByClass: Readonly<Record<CheckClass, number>>
  /** K: the warnings (story points, freshness between the thresholds, suspicious instructions). */
  warnings: number
  /** Warnings the PM must confirm explicitly before approving (story points). */
  confirmations: number
  /** Findings of the reviewer discarded for want of a place. */
  discarded: number
}

const countOf = (d: DetailObject): number => {
  const c: DetailValue | undefined = d.count
  return typeof c === 'number' && Number.isInteger(c) && c > 0 ? c : 0
}

/** «N verifiche, M anomalie» and the warnings, recomputed from the stored rows. */
export function summarizeRedTeam(
  rows: readonly RedTeamRow[],
  acceptances: readonly Acceptance[],
  decisions: readonly PmDecision[],
): RedTeamSummary {
  let checks = 0
  let warnings = 0
  let confirmations = 0
  let discarded = 0
  for (const r of uniqueRows(rows)) {
    if (r.outcome === 'checked') checks += countOf(r.detail)
    if (r.outcome === 'discarded') discarded += countOf(r.detail)
    if (r.outcome === 'warning') {
      warnings++
      if (isRedTeamWarningCode(r.code) && RED_TEAM_WARNINGS[r.code].requiresConfirmation) {
        confirmations++
      }
    }
  }
  const anomalies = anomaliesOfRows(rows, acceptances, decisions)
  const openByClass: Record<CheckClass, number> = { data: 0, form: 0, structure: 0 }
  for (const a of anomalies) if (a.status === 'open') openByClass[a.class]++
  return {
    checks,
    anomalies: anomalies.length,
    open: anomalies.filter((a) => a.status === 'open').length,
    accepted: anomalies.filter((a) => a.status === 'accepted').length,
    decided: anomalies.filter((a) => a.status === 'decided').length,
    openByClass,
    warnings,
    confirmations,
    discarded,
  }
}

// Texts for the PM -------------------------------------------------------------------------------

/** «12 verifiche, 2 anomalie, 1 avviso»: the warnings only when there are some. */
export function redTeamSummaryText(summary: RedTeamSummary, lang: Lang): string {
  const part = (key: string, n: number) =>
    recipeText('redTeam', n === 1 ? `${key}_one` : `${key}_other`, { n }, lang)
  const parts = [part('checks', summary.checks), part('anomalies', summary.anomalies)]
  if (summary.warnings > 0) parts.push(part('warnings', summary.warnings))
  return parts.join(', ')
}

function whereText(ref: RedTeamRef, place: RedTeamPlace, lang: Lang): string {
  if (ref.element === 'internal_note') return recipeText('redTeam', 'where_internal_note', {}, lang)
  const p = { section: place.section ?? '', block: place.block ?? '', column: place.column ?? '' }
  if (place.column !== undefined && place.block !== undefined)
    return recipeText('redTeam', 'where_column', p, lang)
  if (place.block !== undefined) return recipeText('redTeam', 'where_block', p, lang)
  if (place.section !== undefined) return recipeText('redTeam', 'where_section', p, lang)
  return recipeText('redTeam', 'where_document', p, lang)
}

const AUDIENCE_CODES = new Set([
  'internal_data_in_client',
  'internal_note_in_client',
  'internal_section_in_client',
  'client_source_note_not_generic',
  'mixed_script_in_client',
  'story_points_in_client',
])

const str = (v: DetailValue | undefined): string => (typeof v === 'string' ? v : '')

/** The text the PM reads for a finding of the red-team: what it is and where. */
export function redTeamFindingText(
  finding: Pick<RedTeamAnomaly | RedTeamWarning, 'code' | 'ref' | 'place' | 'detail'>,
  lang: Lang,
): string {
  const d = finding.detail
  if (AUDIENCE_CODES.has(finding.code)) {
    const categories = Array.isArray(d.categories)
      ? (d.categories as AudienceAnomaly['categories'])
      : []
    return audienceFindingText(
      {
        code: finding.code as AudienceAnomaly['code'],
        ref: finding.ref as AudienceAnomaly['ref'],
        place: finding.place,
        categories,
        internalSource: d.internalSource === true,
      } as AudienceAnomaly,
      lang,
    )
  }
  // A credential in the title of a cited piece of evidence: no text of the draft can fix it, the
  // PM renames or removes that evidence (the title itself is never repeated).
  if (
    (finding.code === 'credential_in_text' || finding.code === 'secret_in_text') &&
    finding.ref.element === 'source_note'
  ) {
    const key =
      finding.code === 'credential_in_text'
        ? 'credential_in_source_title'
        : 'secret_in_source_title'
    return recipeText('redTeam', key, {}, lang)
  }
  if (CHECK_CODES.has(finding.code)) {
    return recipeText(
      'redTeam',
      finding.code,
      { label: str(d.label), message: str(d.message) },
      lang,
    )
  }
  const params: Record<string, string | number> = {
    where: whereText(finding.ref, finding.place, lang),
    section: finding.place.section ?? '',
    label: str(d.label),
    message: str(d.message),
    subject: str(d.subject),
    declared: str(d.declared) || recipeText('audience', 'parameter_not_deduced', {}, lang),
    current: str(d.current) || recipeText('audience', 'parameter_not_deduced', {}, lang),
    hours: typeof d.ageHours === 'number' ? d.ageHours : '',
    rows: typeof d.rows === 'number' ? d.rows : '',
  }
  const known = isRedTeamAnomalyCode(finding.code) || isRedTeamWarningCode(finding.code)
  const text = recipeText('redTeam', known ? finding.code : 'unknown_finding', params, lang)
  // The words of the text a finding is about, so the PM knows what to ask to fix.
  const excerpt = str(d.excerpt)
  if (excerpt === '') return text
  return [text, recipeText('redTeam', 'excerpt', { excerpt }, lang)].join(' ')
}
