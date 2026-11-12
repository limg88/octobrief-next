import type { VerifiedAnswer } from '../answer-check.ts'
import { canonicalText } from '../canonical.ts'
import { DomainError } from '../errors.ts'
import { canonicalLocator, type Locator } from '../extraction.ts'
import {
  type FreshnessPolicy,
  type FreshnessThresholds,
  freshnessOf,
  tightenFreshness,
} from '../freshness.ts'
import type { Lang } from '../language/index.ts'
import { dataKindsIn } from '../numbers.ts'
import {
  type DocumentSourceRef,
  documentSchema,
  type SourceNote,
} from '../recipe/document-model.ts'
import type { Recipe, RecipeBlock } from '../recipe/format.ts'
import { canonicalHash, canonicalJson } from '../recipe/hash.ts'
import { documentRefOf } from '../recipe/slot-answer.ts'
import type { SourceKind } from '../recipe/source-kinds.ts'
import type { SuspiciousHit } from '../suspicious.ts'
import type { Acceptance } from './acceptance.ts'
import {
  type AudienceContext,
  type AudienceRef,
  type AudienceReport,
  type ClientVersion,
  fillTitle,
  type InternalDocument,
  projectClientVersion,
} from './audience.ts'
import { type PmDecision, statusOf } from './decisions.ts'
import { type DraftElement, draftElements, recipeSectionOf, segmentFingerprint } from './draft.ts'
import {
  type DetailObject,
  GATE_CLASS,
  type GateNumber,
  RED_TEAM_ANOMALIES,
  RED_TEAM_WARNINGS,
  type RedTeamAnomaly,
  type RedTeamAnomalyCode,
  type RedTeamPlace,
  type RedTeamRef,
  type RedTeamWarning,
  type RedTeamWarningCode,
  refKeyOf,
} from './red-team-model.ts'
import { sensitiveKindsIn, technicalKindsIn } from './sensitive-text.ts'

// The common gates of the red-team, always active and in a fixed order, on every element of the
// draft. Each finds, never fixes: a stale source suspends the numbers that cite it (the notes are
// listed), a data anomaly waits for the PM, and nothing here changes the document.

/** How the age of the sources of a draft is judged. */
export interface FreshnessContext {
  /** ISO instant the run is judged at (the reference time of the input snapshot). */
  now: string
  /** The thresholds of the project; looser than the defaults is refused. */
  thresholds: FreshnessThresholds
  /** The kind of every connector source a note cites (trackers, the data warehouse). */
  sourceKinds: Readonly<Record<string, SourceKind>>
  evidence: Readonly<Record<string, { policy: FreshnessPolicy; sourceKind: SourceKind }>>
  facts: Readonly<Record<string, { policy: FreshnessPolicy }>>
}

/** A disagreement between sources the gathering found: shown, never resolved. */
export interface GatheredContradiction {
  /** Stable key of what the sources disagree on. */
  key: string
  /** What it is about, for the PM (no data: the values are in the sides). */
  subject: string
  sides: ReadonlyArray<{ value: string; source: DocumentSourceRef }>
}

/** A value of an approved client version, as registered: the identity and the value shown. */
export interface DeclaredValue {
  recipeSlug: string
  sectionId: string
  /** `declaredCellId`: the value block, or the block, column and row of a cell. */
  cellId: string
  /** `declaredPeriod` of the run that declared it; `null` for a recipe without a period. */
  period: string | null
  value: string | null
  /** ISO instant of the approval. */
  declaredAt: string
}

export interface CommonGatesContext {
  recipe: Recipe
  lang: Lang
  /** The values of the parameters as titles show them, by id of the parameter. */
  parameters: Readonly<Record<string, string>>
  /** The calendar days (`yyyy-mm-dd`) of the period parameters, by id. */
  periods: Readonly<Record<string, { from: string; to: string }>>
  /** Names of people and organizations of the project (pseudonyms for the model). */
  knownNames: readonly string[]
  freshness: FreshnessContext
  /** Facts whose sources disagree. */
  contestedFacts: readonly string[]
  contradictions: readonly GatheredContradiction[]
  declaredValues: readonly DeclaredValue[]
  /** The checks of the verifier on what the model wrote, by slot. */
  slotVerifications: Readonly<Record<string, VerifiedAnswer>>
  /**
   * What the client gate knows, for a deliverable with a client version: the red-team projects
   * the client version itself (`projectClientVersion`), so the gate sees what it withheld.
   */
  client?: { audience: AudienceContext }
  /**
   * The run has no client version though the recipe could have one: the PM did not ask for it
   * (`runHasClientVersion`). Only then is a recipe for the client judged without `client`.
   */
  withoutClientVersion?: true
  acceptances: readonly Acceptance[]
  decisions: readonly PmDecision[]
  /** The suspicious instructions found in each piece of evidence, by id, with their places. */
  suspicious?: Readonly<Record<string, readonly SuspiciousHit[]>>
}

export interface GateTally {
  gate: GateNumber
  class: RedTeamAnomaly['class']
  checks: number
}

export interface CommonGatesReport {
  gates: GateTally[]
  anomalies: RedTeamAnomaly[]
  warnings: RedTeamWarning[]
}

/**
 * The identity of a period for the declared values: the days of the first period parameter of
 * the recipe, `null` when the recipe has none or it was skipped.
 */
export function declaredPeriod(
  recipe: Recipe,
  periods: Readonly<Record<string, { from: string; to: string }>>,
): string | null {
  const p = recipe.parameters.find((x) => x.type === 'period')
  if (p === undefined || !Object.hasOwn(periods, p.id)) return null
  const { from, to } = periods[p.id] as { from: string; to: string }
  return `${from}..${to}`
}

/** The parts of a declared cell id (`declaredCellId`); `null` when it is not one. */
export function parseCellId(id: string): string[] | null {
  try {
    const v: unknown = JSON.parse(id)
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : null
  } catch {
    return null
  }
}

/** The id of a declared value: a value block, or the block, column and row key of a cell. */
export function declaredCellId(block: string, column?: string, row?: string): string {
  return column === undefined ? canonicalJson([block]) : canonicalJson([block, column, row ?? ''])
}

const DAY_MS = 24 * 3_600_000

/** Most characters of the excerpt of a text a finding names. */
export const FINDING_EXCERPT_CHARS = 80

/**
 * The detail of a finding on a text: a short excerpt of its words, cut at a word, so the PM knows
 * which text it is; none for a text holding a credential or a secret, never repeated.
 */
function excerptOf(text: string): DetailObject {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '' || sensitiveKindsIn(flat).length > 0) return {}
  const chars = [...flat]
  if (chars.length <= FINDING_EXCERPT_CHARS) return { excerpt: flat }
  const cut = chars.slice(0, FINDING_EXCERPT_CHARS).join('')
  const space = cut.lastIndexOf(' ')
  const kept = (space > 0 ? cut.slice(0, space) : cut).trimEnd()
  return { excerpt: `${kept}…` }
}

/** Collects the findings of the gates, with their status from the decisions of the PM. */
class Findings {
  readonly anomalies: RedTeamAnomaly[] = []
  readonly warnings: RedTeamWarning[] = []
  private readonly seen = new Set<string>()
  private readonly acceptances: readonly Acceptance[]
  private readonly decisions: readonly PmDecision[]

  constructor(acceptances: readonly Acceptance[], decisions: readonly PmDecision[]) {
    this.acceptances = acceptances
    this.decisions = decisions
  }

  anomaly(
    code: RedTeamAnomalyCode,
    ref: RedTeamRef,
    content: unknown,
    place: RedTeamPlace,
    slot: string | null,
    detail: DetailObject = {},
    /** The fingerprint another gate already computed for the content. */
    knownHash?: string,
  ): void {
    const rule = RED_TEAM_ANOMALIES[code]
    const refKey = refKeyOf(ref)
    const once = `${code}\u0000${refKey}`
    if (this.seen.has(once)) return
    this.seen.add(once)
    const contentHash = knownHash ?? canonicalHash(content)
    const status = statusOf({ code, refKey, contentHash }, this.acceptances, this.decisions)
    this.anomalies.push({
      code,
      gate: rule.gate,
      class: rule.class ?? 'data',
      ref,
      refKey,
      contentHash,
      place,
      slot,
      resolution: rule.resolution,
      status,
      detail,
    })
  }

  warning(
    code: RedTeamWarningCode,
    ref: RedTeamRef,
    content: unknown,
    place: RedTeamPlace,
    detail: DetailObject = {},
    knownHash?: string,
  ): void {
    const rule = RED_TEAM_WARNINGS[code]
    this.warnings.push({
      code,
      gate: rule.gate,
      ref,
      refKey: refKeyOf(ref),
      contentHash: knownHash ?? canonicalHash(content),
      place,
      requiresConfirmation: rule.requiresConfirmation,
      detail,
    })
  }
}

interface Env {
  doc: InternalDocument
  ctx: CommonGatesContext
  elements: readonly DraftElement[]
  notes: ReadonlyMap<number, SourceNote>
  /**
   * The client version and the report of its gate; why it could not be made; `null` for an
   * internal deliverable.
   */
  client: { version: ClientVersion; report: AudienceReport } | { inconsistent: string } | null
  found: Findings
}

type Gate = (env: Env) => number

/** The text of an element, for the gates that read every text. */
function textOf(e: DraftElement): string | null {
  switch (e.kind) {
    case 'title':
    case 'static':
      return e.text
    case 'segment':
    case 'internal_note':
      return e.segment.text
    case 'cell':
      return e.cell.text
    case 'source_note':
      return e.note.label
  }
}

function notesOf(e: DraftElement): readonly number[] {
  if (e.kind === 'segment' || e.kind === 'internal_note') return e.segment.sources
  if (e.kind === 'cell') return e.cell.sources
  return []
}

const hasData = (text: string, lang: Lang) => dataKindsIn(text, lang).length > 0

/** The verified texts of each slot, as fingerprints of their canonical text and nature. */
function verifiedTexts(ctx: CommonGatesContext): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [slot, v] of Object.entries(ctx.slotVerifications)) {
    out.set(
      slot,
      new Set(
        v.segments.map((s) =>
          segmentFingerprint({ text: canonicalText(s.originalText), nature: s.nature }),
        ),
      ),
    )
  }
  return out
}

/**
 * The places each verified text of a slot stands on: its verified sources as places of the draft
 * (a note of the skeleton by the place of that note), by slot and fingerprint of the text.
 */
function verifiedPlaces(
  ctx: CommonGatesContext,
  notes: ReadonlyMap<number, SourceNote>,
): Map<string, Map<string, Set<string>>> {
  const refs = new Map<number, DocumentSourceRef>()
  for (const [n, note] of notes) if ('ref' in note) refs.set(n, note.ref)
  const out = new Map<string, Map<string, Set<string>>>()
  for (const [slot, v] of Object.entries(ctx.slotVerifications)) {
    const bySegment = new Map<string, Set<string>>()
    for (const s of v.segments) {
      const key = segmentFingerprint({ text: canonicalText(s.originalText), nature: s.nature })
      const places = bySegment.get(key) ?? new Set<string>()
      for (const src of s.sources) {
        if (!src.verified) continue
        const ref = documentRefOf(src.ref, refs)
        if (ref !== null) places.add(canonicalJson(ref))
      }
      bySegment.set(key, places)
    }
    out.set(slot, bySegment)
  }
  return out
}

/**
 * The places of the rows the PM excluded, as the draft cites them: the rows of the list that
 * shows an exclusion of the recipe, and the rows of a list of the work items the PM excluded from
 * the counts of the tracker.
 */
function excludedPlaces(doc: InternalDocument, recipe: Recipe): Set<string> {
  const lists = new Set((recipe.exclusions ?? []).map((e) => e.shownIn))
  const blocks = recipe.sections.flatMap((s) => s.blocks)
  const excludedParameters = new Set(
    blocks.flatMap((b) =>
      (b.kind === 'data_table' || b.kind === 'data_list') &&
      b.query.kind === 'tracker' &&
      b.query.decisions?.excluded !== undefined
        ? [b.query.decisions.excluded.parameter]
        : [],
    ),
  )
  for (const b of blocks) {
    if (
      (b.kind === 'data_table' || b.kind === 'data_list') &&
      b.query.kind === 'parameter' &&
      excludedParameters.has(b.query.parameter)
    ) {
      lists.add(b.id)
    }
  }
  const notes = new Map(doc.sourceNotes.map((n) => [n.n, n]))
  const out = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if ((block.kind !== 'list' && block.kind !== 'table') || !lists.has(block.id)) continue
      for (const row of block.kind === 'list' ? block.items : block.rows) {
        for (const cell of row.cells) {
          for (const n of cell.sources) {
            const note = notes.get(n)
            // A table the PM typed is cited as a whole, for the rows kept as well: its citation
            // names no row, so it never stands for an excluded one.
            if (note === undefined || !('ref' in note) || note.ref.kind === 'parameter') continue
            out.add(canonicalJson(note.ref))
          }
        }
      }
    }
  }
  return out
}

const placeKey = (ref: { evidenceId: string; locator: Locator }) =>
  canonicalJson([ref.evidenceId, canonicalLocator(ref.locator)])

/** The places of the passages where the detector found an instruction, when storage knows them. */
function flaggedPlaces(hits: Readonly<Record<string, readonly SuspiciousHit[]>>): Set<string> {
  const out = new Set<string>()
  for (const [evidenceId, list] of Object.entries(hits)) {
    for (const h of list) if (h.locator) out.add(placeKey({ evidenceId, locator: h.locator }))
  }
  return out
}

// 1 — every cited note exists; a statement of fact has a source; every text of a slot was
// checked by the verifier, and its findings are kept. Notes for the PM are not answers of the
// verifier: they are held to the checks of the draft (a fact needs a source, every note exists).
const gateSources: Gate = ({ doc, elements, notes, ctx, found }) => {
  let checks = 0
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'text' || block.segments.length === 0) continue
      if (!Object.hasOwn(ctx.slotVerifications, block.id)) {
        throw new DomainError('red_team_slot_not_verified', { slot: block.id })
      }
    }
  }
  const verified = verifiedTexts(ctx)
  const standsFor = verifiedPlaces(ctx, notes)
  for (const e of elements) {
    if (e.kind === 'segment' && e.slot !== null) {
      const fingerprint = segmentFingerprint({
        text: canonicalText(e.segment.text),
        nature: e.segment.nature,
      })
      // A text the verifier never saw has no verified source, whatever it cites; nor has a text
      // that cites a note none of its verified sources stands for.
      const places = standsFor.get(e.slot)?.get(fingerprint) ?? new Set<string>()
      const unverifiedNote = e.segment.sources.some((n) => {
        const note = notes.get(n)
        return note !== undefined && 'ref' in note && !places.has(canonicalJson(note.ref))
      })
      if (!verified.get(e.slot)?.has(fingerprint) || unverifiedNote) {
        found.anomaly(
          'without_source',
          e.ref,
          e.segment,
          e.place,
          e.slot,
          excerptOf(e.segment.text),
        )
      }
    }
  }
  for (const e of elements) {
    if (e.kind !== 'segment' && e.kind !== 'internal_note' && e.kind !== 'cell') continue
    checks++
    const cited = notesOf(e)
    if (cited.some((n) => !notes.has(n))) {
      found.anomaly('source_note_missing', e.ref, { ref: e.ref, cited }, e.place, e.slot)
    }
    if (e.kind !== 'cell' && e.segment.nature === 'fact' && cited.length === 0) {
      found.anomaly('without_source', e.ref, e.segment, e.place, e.slot, excerptOf(e.segment.text))
    }
  }
  // A text never leans on a row the PM excluded, nor on the passage where the detector found an
  // instruction: the place it cites is the anomaly, whatever the text says.
  const excluded = excludedPlaces(doc, ctx.recipe)
  const flagged = flaggedPlaces(ctx.suspicious ?? {})
  for (const e of elements) {
    if (e.kind !== 'segment') continue
    const places = e.segment.sources.flatMap((n) => {
      const note = notes.get(n)
      return note !== undefined && 'ref' in note ? [note.ref] : []
    })
    checks++
    if (places.some((ref) => excluded.has(canonicalJson(ref)))) {
      found.anomaly(
        'excluded_row_cited',
        e.ref,
        e.segment,
        e.place,
        e.slot,
        excerptOf(e.segment.text),
      )
    }
    if (places.some((ref) => ref.kind === 'evidence' && flagged.has(placeKey(ref)))) {
      found.anomaly(
        'suspicious_passage_cited',
        e.ref,
        e.segment,
        e.place,
        e.slot,
        excerptOf(e.segment.text),
      )
    }
  }
  for (const section of ctx.recipe.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'text_slot' || !Object.hasOwn(ctx.slotVerifications, block.id)) continue
      const verified = ctx.slotVerifications[block.id] as VerifiedAnswer
      for (const seg of verified.segments) {
        checks++
        const ref: RedTeamRef = {
          element: 'segment',
          section: section.id,
          block: block.id,
          segment: segmentFingerprint({ text: seg.originalText, nature: seg.nature }),
        }
        const place = { section: section.title, ...(block.title ? { block: block.title } : {}) }
        const content = { text: seg.originalText, nature: seg.nature }
        if (seg.withoutSource) {
          found.anomaly('without_source', ref, content, place, block.id, excerptOf(content.text))
        }
        if (seg.mixedScript) found.anomaly('mixed_script', ref, content, place, block.id)
      }
    }
  }
  return checks
}

/** Which source of the project a note cites, and how its age is judged. */
function sourceOfNote(
  ref: DocumentSourceRef,
  f: FreshnessContext,
): { key: string; policy: FreshnessPolicy; kind: SourceKind | null } | null {
  switch (ref.kind) {
    case 'system_row':
      return {
        key: `system:${ref.sourceId}`,
        policy: 'system',
        kind: f.sourceKinds[ref.sourceId] ?? null,
      }
    case 'work_item':
    case 'work_item_counts':
      return {
        key: `tracker:${ref.sourceId}`,
        policy: 'system',
        kind: f.sourceKinds[ref.sourceId] ?? null,
      }
    case 'evidence': {
      const e = Object.hasOwn(f.evidence, ref.evidenceId) ? f.evidence[ref.evidenceId] : undefined
      // Unknown to the context: judged as system data (fail closed).
      return {
        key: `evidence:${ref.evidenceId}`,
        policy: e?.policy ?? 'system',
        kind: e?.sourceKind ?? null,
      }
    }
    case 'fact': {
      const x = Object.hasOwn(f.facts, ref.factId) ? f.facts[ref.factId] : undefined
      return { key: `fact:${ref.factId}`, policy: x?.policy ?? 'system', kind: null }
    }
    case 'parameter':
      return null
  }
}

/** The thresholds of a source: the project's, made stricter by the recipe for its kind. */
function thresholdsFor(kind: SourceKind | null, base: FreshnessThresholds, recipe: Recipe) {
  let t = base
  for (const p of recipe.prerequisites) {
    if (p.kind !== 'source' || p.freshness === undefined || kind === null) continue
    if (!p.sourceKinds.includes(kind)) continue
    t = {
      warnAfterHours: Math.min(t.warnAfterHours, p.freshness.warnAfterHours),
      stopAfterHours: Math.min(t.stopAfterHours, p.freshness.stopAfterHours),
    }
  }
  return t
}

// 2 — freshness of system data, judged once per source on its oldest note.
const gateFreshness: Gate = ({ doc, ctx, found }) => {
  const f = ctx.freshness
  const base = tightenFreshness(f.thresholds)
  const now = new Date(f.now)
  const bySource = new Map<string, { kind: SourceKind | null; notes: SourceNote[] }>()
  for (const note of doc.sourceNotes) {
    if (!('ref' in note)) continue
    const source = sourceOfNote(note.ref, f)
    if (source === null || source.policy !== 'system') continue
    const entry = bySource.get(source.key) ?? { kind: source.kind, notes: [] }
    entry.notes.push(note)
    bySource.set(source.key, entry)
  }
  for (const [key, { kind, notes }] of bySource) {
    const ref: RedTeamRef = { element: 'source', source: key }
    const numbers = notes.map((n) => n.n)
    const label = (notes[0] as SourceNote).label
    if (notes.some((n) => n.dataAsOf === null)) {
      found.anomaly('source_freshness_unknown', ref, { key, dataAsOf: null }, {}, null, {
        label,
        notes: numbers,
      })
      continue
    }
    const times = notes.map((n) => Date.parse(n.dataAsOf as string))
    const oldest = times.reduce((a, b) => Math.min(a, b))
    const oldestIso = new Date(oldest).toISOString()
    if (times.some((t) => t > now.getTime() + DAY_MS)) {
      found.anomaly('source_date_in_future', ref, { key, dates: times }, {}, null, {
        label,
        notes: numbers,
      })
      continue
    }
    const { level, ageHours } = freshnessOf(
      new Date(oldest),
      now,
      thresholdsFor(kind, base, ctx.recipe),
    )
    const detail = { label, notes: numbers, ageHours: Math.floor(ageHours), dataAsOf: oldestIso }
    if (level === 'stale') {
      found.anomaly('stale_source', ref, { key, dataAsOf: oldestIso }, {}, null, detail)
    } else if (level === 'warning') {
      found.warning('source_freshness_warning', ref, { key, dataAsOf: oldestIso }, {}, detail)
    }
  }
  return bySource.size
}

/** Whether a text mentions one of the known names, as a whole word and ignoring case. */
function nameIn(text: string, names: readonly string[]): boolean {
  const folded = ` ${canonicalText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  return names.some((n) => {
    const name = canonicalText(n)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
    return name !== '' && folded.includes(` ${name} `)
  })
}

// 3 — link phrases carry no data; titles and fixed texts are those of the recipe.
const gateForm: Gate = ({ elements, ctx, found }) => {
  let checks = 0
  for (const e of elements) {
    if (e.kind === 'segment' || e.kind === 'internal_note') {
      if (e.segment.sources.length > 0 || e.segment.nature === 'fact') continue
      checks++
      if (hasData(e.segment.text, ctx.lang)) {
        found.anomaly('connector_with_data', e.ref, e.segment, e.place, e.slot)
      } else if (nameIn(e.segment.text, ctx.knownNames)) {
        // A name without a number is not a datum without source: the PM may keep it.
        found.anomaly('connector_with_name', e.ref, e.segment, e.place, e.slot)
      }
    } else if (e.kind === 'title') {
      checks++
      const expected =
        e.recipeTitle === null ? null : fillTitle(e.recipeTitle, ctx.parameters, ctx.lang)
      if (e.text !== expected && hasData(e.text, ctx.lang)) {
        found.anomaly('title_with_data', e.ref, { text: e.text }, e.place, null)
      }
    } else if (e.kind === 'static') {
      checks++
      if (e.text !== e.recipeText && hasData(e.text, ctx.lang)) {
        found.anomaly('static_with_data', e.ref, { text: e.text }, e.place, null)
      }
    }
  }
  return checks
}

// 4 — a value shown has a source; otherwise it must be «non dedotto».
const gateNotDeduced: Gate = ({ elements, found }) => {
  let checks = 0
  for (const e of elements) {
    if (e.kind !== 'cell') continue
    checks++
    if (e.cell.text !== null && e.cell.sources.length === 0) {
      found.anomaly('value_without_source', e.ref, e.cell, e.place, null)
    }
  }
  return checks
}

// 5 — the separation between internal and client version (`projectClientVersion`).
const gateAudience: Gate = ({ client, found }) => {
  if (client === null) return 0
  if ('inconsistent' in client) {
    // The draft does not match its recipe: no client version can be made of it.
    found.anomaly(
      'client_version_inconsistent',
      { element: 'section', section: '' },
      { reason: client.inconsistent },
      {},
      null,
      { reason: client.inconsistent },
    )
    return 1
  }
  const { report } = client
  // The fingerprints of the audience gate are kept: acceptances are bound to them.
  for (const a of report.anomalies) {
    const detail = { categories: a.categories, terms: a.terms, internalSource: a.internalSource }
    found.anomaly(a.code, a.ref, null, a.place, null, detail, a.contentHash)
  }
  for (const w of report.warnings) {
    found.warning('story_points_in_client', w.ref, null, w.place, { terms: w.terms }, w.contentHash)
  }
  return report.checks
}

// 6 — credentials and secrets, in every text, never acceptable.
const gateSecrets: Gate = ({ elements, found }) => {
  let checks = 0
  for (const e of elements) {
    const text = textOf(e)
    if (text === null) continue
    checks++
    for (const kind of sensitiveKindsIn(text)) {
      found.anomaly(
        kind === 'credential' ? 'credential_in_text' : 'secret_in_text',
        e.ref,
        { text },
        e.place,
        e.slot,
      )
    }
  }
  return checks
}

// 7 — paths and technical identifiers in what the model writes and in titles; the id of a work
// item the element cites is data.
const gateTechnical: Gate = ({ elements, notes, ctx, found }) => {
  let checks = 0
  for (const e of elements) {
    if (e.kind !== 'segment' && e.kind !== 'internal_note' && e.kind !== 'title') continue
    checks++
    const text = e.kind === 'title' ? e.text : e.segment.text
    const cited = new Set<string>()
    for (const n of notesOf(e)) {
      const note = notes.get(n)
      if (note && 'ref' in note && note.ref.kind === 'work_item')
        cited.add(note.ref.id.toLowerCase())
    }
    for (const kind of technicalKindsIn(text, cited, ctx.lang)) {
      found.anomaly(
        kind === 'path' ? 'technical_path' : 'technical_identifier',
        e.ref,
        { text },
        e.place,
        e.slot,
      )
    }
  }
  return checks
}

const DOC_KIND: Readonly<Record<RecipeBlock['kind'], string>> = {
  data_table: 'table',
  data_list: 'list',
  data_value: 'value',
  text_slot: 'text',
  static: 'static',
}

// 8 — the structure of the recipe: mandatory sections, their order, blocks and columns.
const gateStructure: Gate = ({ doc, ctx, found }) => {
  let checks = 0
  const recipe = ctx.recipe
  const order = new Map(recipe.sections.map((s, i) => [s.id, i]))
  const present = new Set<string>()
  let last = -1
  for (const section of doc.sections) {
    checks++
    const ref: AudienceRef = { element: 'section', section: section.id }
    const place = { section: section.title }
    const at = order.get(section.id)
    if (at === undefined || present.has(section.id)) {
      found.anomaly('section_unexpected', ref, { id: section.id }, place, null)
      continue
    }
    present.add(section.id)
    if (at < last) found.anomaly('section_out_of_order', ref, { id: section.id }, place, null)
    last = Math.max(last, at)
    const rs = recipeSectionOf(recipe, section.id)
    if (rs === undefined) continue
    const expected = rs.blocks.map((b) => `${DOC_KIND[b.kind]}:${b.id}`)
    const actual = section.blocks.map((b) => `${b.kind}:${b.id}`)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      found.anomaly('blocks_mismatch', ref, { expected, actual }, place, null)
    }
    for (const block of section.blocks) {
      if (block.kind !== 'table' && block.kind !== 'list') continue
      checks++
      const rb = rs.blocks.find((b) => b.id === block.id)
      const bRef: RedTeamRef = { element: 'block', section: section.id, block: block.id }
      const bPlace = { ...place, ...(block.title ? { block: block.title } : {}) }
      if (rb && (rb.kind === 'data_table' || rb.kind === 'data_list')) {
        const want = rb.columns.map((c) => c.id)
        const have = block.columns.map((c) => c.id)
        if (canonicalJson(want) !== canonicalJson(have)) {
          found.anomaly('columns_mismatch', bRef, { want, have }, bPlace, null)
        }
      }
      const rows = block.kind === 'table' ? block.rows : block.items
      const bad = rows.filter((r) => r.cells.length !== block.columns.length).map((r) => r.key)
      if (bad.length > 0) found.anomaly('row_cells_mismatch', bRef, { bad }, bPlace, null)
    }
  }
  for (const rs of recipe.sections) {
    checks++
    if (!rs.required || present.has(rs.id)) continue
    found.anomaly(
      'required_section_missing',
      { element: 'section', section: rs.id },
      { id: rs.id },
      { section: fillTitle(rs.title, ctx.parameters, ctx.lang) },
      null,
    )
  }
  return checks
}

// 9 — contradictions between sources, until the PM decides them.
const gateContradictions: Gate = ({ elements, notes, ctx, found }) => {
  let checks = 0
  for (const c of ctx.contradictions) {
    checks++
    found.anomaly(
      'contradiction_open',
      // Keys of the gathering and of contested facts never collide: each has its prefix.
      { element: 'contradiction', contradiction: `gathered:${c.key}` },
      { sides: c.sides },
      {},
      null,
      { subject: c.subject, sides: c.sides.length },
    )
  }
  const contested = new Set(ctx.contestedFacts)
  const cited = new Map<string, RedTeamPlace>()
  for (const e of elements) {
    for (const n of notesOf(e)) {
      const note = notes.get(n)
      if (note && 'ref' in note && note.ref.kind === 'fact' && contested.has(note.ref.factId)) {
        if (!cited.has(note.ref.factId)) cited.set(note.ref.factId, e.place)
      }
    }
  }
  for (const [factId, place] of cited) {
    checks++
    found.anomaly(
      'contradiction_open',
      { element: 'contradiction', contradiction: `fact:${factId}` },
      { fact: factId },
      place,
      null,
    )
  }
  return checks
}

// 10 — the values already declared to the client, for the same recipe, section, cell and period.
const gateDeclared: Gate = ({ ctx, client, found }) => {
  if (client === null || 'inconsistent' in client) return 0
  const doc = client.version.document
  const period = declaredPeriod(ctx.recipe, ctx.periods)
  const current = new Map<string, { value: string | null; place: RedTeamPlace }>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      const place = { section: section.title }
      if (block.kind === 'value') {
        current.set(canonicalJson([section.id, declaredCellId(block.id)]), {
          value: block.cell.text,
          place: { ...place, block: block.label },
        })
      } else if (block.kind === 'table' || block.kind === 'list') {
        const rows = block.kind === 'table' ? block.rows : block.items
        for (const row of rows) {
          row.cells.forEach((cell, i) => {
            const column = block.columns[i]
            if (column === undefined) return
            current.set(canonicalJson([section.id, declaredCellId(block.id, column.id, row.key)]), {
              value: cell.text,
              place: {
                ...place,
                ...(block.title ? { block: block.title } : {}),
                column: column.title,
              },
            })
          })
        }
      }
    }
  }
  // What the client version withholds for an open anomaly of gate 5 is shown there, not here.
  const withheld = new Set<string>()
  for (const a of client.report.anomalies) {
    if (a.status !== 'open') continue
    if (a.ref.element === 'value') withheld.add(canonicalJson([a.ref.section, a.ref.block]))
    if (a.ref.element === 'column') {
      withheld.add(canonicalJson([a.ref.section, a.ref.block, a.ref.column]))
    }
  }
  const isWithheld = (d: DeclaredValue) => {
    const id = parseCellId(d.cellId)
    if (id === null) return false
    const [block, column] = id
    return (
      withheld.has(canonicalJson([d.sectionId, block])) ||
      (column !== undefined && withheld.has(canonicalJson([d.sectionId, block, column])))
    )
  }
  let checks = 0
  for (const d of ctx.declaredValues) {
    if (d.recipeSlug !== ctx.recipe.slug || d.period !== period || isWithheld(d)) continue
    checks++
    const now = current.get(canonicalJson([d.sectionId, d.cellId]))
    const shown = now?.value ?? null
    const same = (a: string | null, b: string | null) =>
      (a === null ? null : canonicalText(a)) === (b === null ? null : canonicalText(b))
    if (!same(shown, d.value)) {
      found.anomaly(
        'declared_value_changed',
        { element: 'declared_value', section: d.sectionId, cell: d.cellId },
        { declared: d.value, current: shown },
        now?.place ?? {},
        null,
        { declared: d.value, current: shown, declaredAt: d.declaredAt },
      )
    }
  }
  return checks
}

/** The common gates, by number, in the order they run. */
const GATES: ReadonlyArray<readonly [GateNumber, Gate]> = [
  [1, gateSources],
  [2, gateFreshness],
  [3, gateForm],
  [4, gateNotDeduced],
  [5, gateAudience],
  [6, gateSecrets],
  [7, gateTechnical],
  [8, gateStructure],
  [9, gateContradictions],
  [10, gateDeclared],
]

/** The client version of the draft, or why the draft cannot give one (an anomaly of gate 5). */
function clientVersionOf(
  doc: InternalDocument,
  audience: AudienceContext,
  acceptances: readonly Acceptance[],
): Env['client'] {
  try {
    return projectClientVersion(doc, audience, acceptances)
  } catch (e) {
    if (e instanceof DomainError && e.code === 'client_version_inconsistent') {
      return { inconsistent: String(e.params?.reason ?? 'unknown') }
    }
    throw e
  }
}

/** Runs the ten common gates on an internal draft, in their fixed order. */
export function runCommonGates(doc: InternalDocument, ctx: CommonGatesContext): CommonGatesReport {
  // A deliverable with a client version is never checked without it (fail closed).
  if (
    ctx.recipe.audience !== 'internal' &&
    ctx.client === undefined &&
    !(ctx.withoutClientVersion === true && ctx.recipe.clientVersionWhen !== undefined)
  ) {
    throw new DomainError('red_team_without_client_version')
  }
  if (ctx.withoutClientVersion === true && ctx.client !== undefined) {
    throw new DomainError('red_team_without_client_version')
  }
  // A draft that is not a document (a date that is no date, a missing field) is not judged.
  const parsed = documentSchema.safeParse(doc)
  if (
    !parsed.success ||
    parsed.data.audience !== 'internal' ||
    Number.isNaN(Date.parse(ctx.freshness.now))
  ) {
    throw new DomainError('red_team_draft_malformed')
  }
  const found = new Findings(ctx.acceptances, ctx.decisions)
  const env: Env = {
    doc,
    ctx,
    elements: draftElements(doc, ctx.recipe),
    notes: new Map(doc.sourceNotes.map((n) => [n.n, n])),
    client:
      ctx.client === undefined ? null : clientVersionOf(doc, ctx.client.audience, ctx.acceptances),
    found,
  }
  const gates = GATES.map(([gate, run]) => ({ gate, class: GATE_CLASS[gate], checks: run(env) }))
  return { gates, anomalies: found.anomalies, warnings: found.warnings }
}

/** The suspicious instructions in the evidence the draft cites: warnings with their place. */
export function suspiciousWarnings(
  doc: InternalDocument,
  hits: Readonly<Record<string, readonly SuspiciousHit[]>>,
): RedTeamWarning[] {
  const found = new Findings([], [])
  const cited = new Set<string>()
  for (const note of doc.sourceNotes) {
    if (note.ref.kind === 'evidence') cited.add(note.ref.evidenceId)
  }
  for (const id of [...cited].sort()) {
    const list = Object.hasOwn(hits, id) ? (hits[id] as readonly SuspiciousHit[]) : []
    const patterns = new Map<string, number[]>()
    for (const h of list)
      patterns.set(h.pattern, [...(patterns.get(h.pattern) ?? []), h.chunkIndex])
    for (const [pattern, chunks] of patterns) {
      found.warning(
        'suspicious_instruction',
        { element: 'source', source: `evidence:${id}` },
        { id, pattern, chunks },
        {},
        { pattern, chunks },
      )
    }
  }
  return found.warnings
}
