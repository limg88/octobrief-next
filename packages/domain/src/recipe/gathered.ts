import { DomainError } from '../errors.ts'
import type { FreshnessPolicy, SourceFreshnessLevel } from '../freshness.ts'
import type { EvidenceAudience, FactAudience } from '../gate/audience.ts'
import type { FreshnessContext, GatheredContradiction } from '../gate/common-gates.ts'
import { type Lang, vocabulary } from '../language/index.ts'
import type { SourceAudience } from '../search.ts'
import { parseCalendarDay } from '../tracker.ts'
import type { DataCategory } from './categories.ts'
import type { DocumentSourceRef } from './document-model.ts'
import {
  type Recipe,
  type RecipeBlock,
  type RecipeParameter,
  type RecipeQuery,
  type RecipeSection,
  TITLE_PARAMETER_TYPES,
  TITLE_PLACEHOLDER,
} from './format.ts'
import { recipeText } from './messages/index.ts'
import { type TypedRow, typedRowsFit, typedRowsProblem } from './rows-parameter.ts'

// What a run of a recipe gathers before anything is written: the values of the parameters, the
// rows each data block read, the source note of every place read (with its date), the log of
// every value read, the contradictions between sources and the context the red-team needs. The
// code reads it all, deterministically, without the model; the skeleton is computed from it.

/** The texts of the gathering in the dictionary. */
export type GatheringTextKey =
  | 'period'
  | 'yes'
  | 'no'
  | 'note_work_item'
  | 'note_work_item_counts'
  | 'note_work_item_counts_decided'
  | 'work_item_title'
  | 'work_item_title_not_read'
  | 'note_parameter'
  | 'note_fact'
  | 'dated_by_acquisition'
  | 'contradiction_subject'
  | 'ready'
  | 'needs_step'
  | 'missing_system_data'
  | 'need_evidence'
  | 'need_source'
  | 'need_fact'
  | 'need_fact_key'
  | 'step_evidence'
  | 'step_source'
  | 'step_fact'
  | 'step_fact_key'
  | 'data_never_synced'
  | 'data_stale'
  | 'data_undated'
  | 'list_separator'
  | 'remark_filter_dropped'
  | 'remark_selection_dropped'
  | 'remark_source_not_synced'
  | 'remark_internal_source_left_out'
  | 'remark_sprint_not_found'
  | 'note_parameter_from_documents'
  | 'rows_without_evidence'
  | 'rows_invalid'
  | 'rows_invalid_table'

/** The value the PM gave a parameter; a parameter without one was skipped. */
export type ParameterValue =
  | { type: 'text'; value: string }
  | { type: 'date'; day: string }
  | { type: 'period'; from: string; to: string }
  | { type: 'choice'; value: string }
  | { type: 'number'; value: number }
  | { type: 'evidence_selection'; evidenceIds: readonly string[] }
  | {
      type: 'work_item_selection'
      items: ReadonlyArray<{ sourceId: string; id: string }>
    }
  /** A table the PM typed: one value per declared column in every row. */
  | { type: 'rows'; rows: readonly TypedRow[] }

export type ParameterValues = Readonly<Record<string, ParameterValue>>

const isDay = (s: string): boolean => parseCalendarDay(s) !== null

/** Whether a value fits its parameter: type, days, range, options, length. */
function fits(p: RecipeParameter, v: ParameterValue): boolean {
  if (v.type !== p.type) return false
  switch (v.type) {
    case 'text':
      return p.type === 'text' && v.value.trim() !== '' && [...v.value].length <= p.maxLength
    case 'date':
      return isDay(v.day)
    case 'period':
      return isDay(v.from) && isDay(v.to) && v.from <= v.to
    case 'choice':
      return p.type === 'choice' && p.options.some((o) => o.value === v.value)
    case 'number':
      return (
        p.type === 'number' &&
        Number.isFinite(v.value) &&
        (!p.integer || Number.isInteger(v.value)) &&
        (p.min === undefined || v.value >= p.min) &&
        (p.max === undefined || v.value <= p.max)
      )
    case 'evidence_selection':
      return (
        p.type === 'evidence_selection' &&
        v.evidenceIds.length > 0 &&
        v.evidenceIds.length <= MAX_SELECTED &&
        (p.multiple || v.evidenceIds.length === 1)
      )
    case 'work_item_selection':
      return (
        p.type === 'work_item_selection' &&
        v.items.length > 0 &&
        v.items.length <= MAX_SELECTED &&
        (p.multiple || v.items.length === 1)
      )
    case 'rows':
      return (
        p.type === 'rows' &&
        Array.isArray(v.rows) &&
        typedRowsFit(p.columns, p.maxRows, v.rows, p.key)
      )
  }
}

/**
 * The values of the parameters, checked against the recipe: a value for a parameter the recipe
 * does not ask, or that does not fit it, stops the run (`recipe_parameter_invalid`, with the
 * label of the parameter for the PM).
 */
export function checkParameterValues(recipe: Recipe, values: ParameterValues): ParameterValues {
  const out: Record<string, ParameterValue> = {}
  for (const [id, v] of Object.entries(values)) {
    const p = recipe.parameters.find((x) => x.id === id)
    if (p === undefined) throw new DomainError('recipe_parameter_invalid', { name: '' })
    if (p.type === 'rows' && v.type === 'rows' && Array.isArray(v.rows)) {
      // A table tells the PM the row and the column that do not fit.
      const problem = typedRowsProblem(p.columns, p.maxRows, v.rows, p.key)
      if (problem !== null && problem.row !== null) {
        throw new DomainError('recipe_rows_invalid', {
          name: p.label,
          row: problem.row,
          column: problem.column ?? '',
        })
      }
      if (problem !== null) throw new DomainError('recipe_rows_table_invalid', { name: p.label })
    }
    if (!fits(p, v)) throw new DomainError('recipe_parameter_invalid', { name: p.label })
    out[id] = structuredClone(v)
  }
  // A table copied from documents comes with the documents it was copied from.
  for (const p of recipe.parameters) {
    if (p.type !== 'rows' || p.evidence === undefined || !Object.hasOwn(out, p.id)) continue
    if (Object.hasOwn(out, p.evidence)) continue
    const document = recipe.parameters.find((x) => x.id === p.evidence)?.label ?? ''
    throw new DomainError('recipe_rows_without_evidence', { name: p.label, document })
  }
  return out
}

/** The text for the PM of a value refused for a table; null for any other refusal. */
export function parameterErrorText(error: DomainError, lang: Lang): string | null {
  const params = error.params ?? {}
  switch (error.code) {
    case 'recipe_rows_without_evidence':
      return recipeText('gathering', 'rows_without_evidence', params, lang)
    case 'recipe_rows_invalid':
      return recipeText('gathering', 'rows_invalid', params, lang)
    case 'recipe_rows_table_invalid':
      return recipeText('gathering', 'rows_invalid_table', params, lang)
    default:
      return null
  }
}

/** A calendar day as the PM writes it: `gg/mm/aaaa`. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-')
  return `${d}/${m}/${y}`
}

/** How each language writes numbers: plain, money (two decimals), percentages. */
const NUMBER_FORMATS: Readonly<
  Record<Lang, { plain: Intl.NumberFormat; money: Intl.NumberFormat; percent: Intl.NumberFormat }>
> = {
  it: {
    // Thousands always grouped: «8.000,00» beside «12.000,00», as a PM writes them.
    plain: new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2, useGrouping: 'always' }),
    money: new Intl.NumberFormat('it-IT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: 'always',
    }),
    percent: new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1, useGrouping: 'always' }),
  },
}

/** Categories whose numbers are money: shown with two decimals. */
const MONEY: readonly DataCategory[] = [
  'contract_amounts',
  'invoiced_amounts',
  'costs',
  'margins',
  'rates',
]

/** A number as the document shows it, in the notation of the language. */
export function formatNumber(value: number, category: DataCategory, lang: Lang): string {
  const f = NUMBER_FORMATS[lang]
  // A negative zero is zero: never «-0,00».
  return (MONEY.includes(category) ? f.money : f.plain).format(value === 0 ? 0 : value)
}

const AS_SHOWN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false })

/**
 * A number at the precision the document shows it (two decimals, rounded as the display rounds
 * it): totals are computed from what the cells show, so a column always adds up to its total.
 */
export function shownNumber(value: number): number {
  const n = Number(AS_SHOWN.format(value))
  return n === 0 ? 0 : n
}

/** A ratio as the document shows it: a percentage. */
export function formatPercent(ratio: number, lang: Lang): string {
  return `${NUMBER_FORMATS[lang].percent.format(ratio * 100)}%`
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** A period as a title shows it: «ottobre 2026» for a whole month, else its two days. */
export function periodText(from: string, to: string, lang: Lang): string {
  const a = parseCalendarDay(from)
  const b = parseCalendarDay(to)
  if (a && b && a.y === b.y && a.m === b.m && a.d === 1 && b.d === lastDayOfMonth(b.y, b.m)) {
    return `${vocabulary(lang).FULL_MONTHS[a.m - 1]} ${a.y}`
  }
  return recipeText('gathering', 'period', { from: formatDay(from), to: formatDay(to) }, lang)
}

/**
 * The values of the parameters as titles show them, by id: a period, a choice (its label), a
 * number. The run gives the same texts to the client gate (`AudienceContext.parameters`).
 */
export function parameterTitleTexts(
  recipe: Recipe,
  values: ParameterValues,
  lang: Lang,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of recipe.parameters) {
    if (!TITLE_PARAMETER_TYPES.includes(p.type) || !Object.hasOwn(values, p.id)) continue
    const v = values[p.id] as ParameterValue
    if (v.type === 'period') out[p.id] = periodText(v.from, v.to, lang)
    if (v.type === 'choice' && p.type === 'choice') {
      out[p.id] = p.options.find((o) => o.value === v.value)?.label ?? v.value
    }
    if (v.type === 'number') out[p.id] = formatNumber(v.value, 'other', lang)
  }
  return out
}

/** The days of the period parameters, by id, as the gates read them. */
export function periodsOf(values: ParameterValues): Record<string, { from: string; to: string }> {
  const out: Record<string, { from: string; to: string }> = {}
  for (const [id, v] of Object.entries(values)) {
    if (v.type === 'period') out[id] = { from: v.from, to: v.to }
  }
  return out
}

function titleParameters(title: string | undefined, into: Set<string>): void {
  if (title === undefined) return
  for (const [, id] of title.matchAll(TITLE_PLACEHOLDER)) if (id !== undefined) into.add(id)
}

function queryParameters(q: RecipeQuery, into: Set<string>): void {
  const ref = (v: unknown) => {
    if (typeof v === 'object' && v !== null && 'parameter' in v) {
      into.add((v as { parameter: string }).parameter)
    }
  }
  switch (q.kind) {
    case 'tracker': {
      const f = q.filter
      for (const list of [
        f.types,
        f.excludedTypes,
        f.states,
        f.sprints,
        f.iterations,
        f.areas,
        f.assignees,
      ]) {
        for (const v of list ?? []) ref(v)
      }
      ref(f.dates?.from)
      ref(f.dates?.to)
      ref(f.dates?.period)
      ref(q.decisions?.excluded)
      ref(q.decisions?.attributions)
      return
    }
    case 'system_rows':
      for (const w of q.where ?? []) ref(w.equals)
      ref(q.dates?.period)
      return
    case 'evidence':
      ref(q.period)
      return
    case 'parameter':
      into.add(q.parameter)
      return
    case 'facts':
      return
  }
}

/** The parameters a block reads: in its title, its query or what it computes. */
export function blockParameters(block: RecipeBlock): Set<string> {
  const out = new Set<string>()
  switch (block.kind) {
    case 'data_table':
    case 'data_list':
      titleParameters(block.title, out)
      for (const c of block.columns) titleParameters(c.title, out)
      queryParameters(block.query, out)
      break
    case 'data_value': {
      titleParameters(block.label, out)
      const c = block.compute
      if (c.op === 'parameter') out.add(c.parameter)
      if (c.op === 'ratio' || c.op === 'difference') {
        for (const r of [c.left, c.right]) if ('parameter' in r) out.add(r.parameter)
      }
      break
    }
    case 'text_slot':
      titleParameters(block.title, out)
      break
    case 'static':
      break
  }
  return out
}

/** The parameters a section reads: in its title and in its blocks. */
export function sectionParameters(section: RecipeSection): Set<string> {
  const out = new Set<string>()
  titleParameters(section.title, out)
  for (const b of section.blocks) for (const p of blockParameters(b)) out.add(p)
  return out
}

/**
 * The sections a mandatory parameter the PM skipped makes «non dedotto»: those that read it, in
 * a title, a query or a computed value.
 */
export function notDeducedSections(recipe: Recipe, values: ParameterValues): Set<string> {
  const skipped = new Set(
    recipe.parameters.filter((p) => p.required && !Object.hasOwn(values, p.id)).map((p) => p.id),
  )
  const out = new Set<string>()
  if (skipped.size === 0) return out
  for (const s of recipe.sections) {
    if ([...sectionParameters(s)].some((p) => skipped.has(p))) out.add(s.id)
  }
  return out
}

// What was read --------------------------------------------------------------------------------

/** A calendar day (`yyyy-mm-dd`) among the values read. */
export interface DayValue {
  day: string
}

/** A value of a field as it was read: text, number, flag, a list of tags, a day, or nothing. */
export type FieldValue = string | number | boolean | null | readonly string[] | DayValue

/** One row a block read: the value of each field, and the place each field was read at. */
export interface GatheredRow {
  values: Readonly<Record<string, FieldValue>>
  /** The place of each field; a field without a place is «non dedotto». */
  refs: Readonly<Record<string, DocumentSourceRef>>
}

export const NOT_DEDUCED_REASONS = [
  'parameter_skipped',
  'no_source',
  'source_not_synced',
  'too_many_rows',
  /** A document for the client, and no tracker of the project holds the client's data. */
  'no_client_source',
  /** No work item of the trackers is in the sprint the block reads: its name may be wrong. */
  'sprint_not_found',
] as const
export type NotDeducedReason = (typeof NOT_DEDUCED_REASONS)[number]

/** What a data block read, or why it could read nothing. */
export type GatheredBlock =
  | {
      status: 'read'
      rows: readonly GatheredRow[]
      /**
       * The places a count or a total of the block cites, when the source computes them (the
       * counts of a tracker); empty: they cite the rows they read.
       */
      totals: readonly DocumentSourceRef[]
      /** What the PM should know of how the block was read (a filter dropped, a choice left out). */
      remarks?: readonly BlockRemark[]
    }
  | { status: 'not_deduced'; reason: NotDeducedReason; remarks?: readonly BlockRemark[] }

/** Something about how a block was read, for the PM: never a datum. */
export type BlockRemark =
  /** An optional parameter was skipped: its filter was not applied, the block is wider. */
  | { code: 'filter_dropped'; parameter: string }
  /** Some of what the PM selected is no longer there (removed, out of the project): left out. */
  | { code: 'selection_dropped'; count: number }
  /** A source of the block has not finished a sync: its data is not in the block. */
  | { code: 'source_not_synced'; source: string }
  /** A document for the client: an internal tracker of the project is not counted. */
  | { code: 'internal_source_left_out'; source: string }
  /** No work item is in the sprint asked: never a count of zero, the name may be wrong. */
  | { code: 'sprint_not_found'; sprint: string }

/** The text of a remark for the PM. */
export function blockRemarkText(remark: BlockRemark, lang: Lang): string {
  switch (remark.code) {
    case 'filter_dropped':
      return recipeText('gathering', 'remark_filter_dropped', { name: remark.parameter }, lang)
    case 'selection_dropped':
      return recipeText('gathering', 'remark_selection_dropped', { count: remark.count }, lang)
    case 'source_not_synced':
      return recipeText('gathering', 'remark_source_not_synced', { source: remark.source }, lang)
    case 'internal_source_left_out':
      return recipeText(
        'gathering',
        'remark_internal_source_left_out',
        { source: remark.source },
        lang,
      )
    case 'sprint_not_found':
      return recipeText('gathering', 'remark_sprint_not_found', { sprint: remark.sprint }, lang)
  }
}

/** Rows a block reads at most: beyond it the block is «non dedotto», never cut silently. */
export const MAX_BLOCK_ROWS = 20_000
/** Items the PM can select for one parameter. */
export const MAX_SELECTED = 200

/** A place read, with its title and the date of its data (null when the source does not say). */
export interface GatheredNote {
  ref: DocumentSourceRef
  label: string
  dataAsOf: string | null
}

/** One value read, where, and the numbers it shows: the base for checking what is written. */
export interface RecipeRead {
  ref: DocumentSourceRef
  values: Readonly<Record<string, FieldValue>>
}

/** How fresh a source is at the reference time, for the PM and the gates. */
export interface SourceFreshness {
  /** `system:…`, `tracker:…`, `evidence:…`, `fact:…`. */
  source: string
  policy: FreshnessPolicy
  /** `unknown`: the source does not date its data, «non dedotto». */
  level: SourceFreshnessLevel | 'unknown'
  dataAsOf: string | null
  /** Data warehouse: when the extraction read the view, when the warehouse synced it. */
  extractedAt?: string
  sourceSyncedAt?: string | null
  /** A document dated by its acquisition, declared as such. */
  datedByAcquisition?: true
}

/** Everything a run gathered, the input of the skeleton. */
export interface GatheredData {
  recipe: { slug: string; version: string }
  lang: Lang
  /** ISO instant the run is computed at: the reference time of the snapshot. */
  referenceTime: string
  parameters: ParameterValues
  /** The values of the parameters as titles show them. */
  parameterTexts: Readonly<Record<string, string>>
  periods: Readonly<Record<string, { from: string; to: string }>>
  blocks: Readonly<Record<string, GatheredBlock>>
  notes: readonly GatheredNote[]
  readLog: readonly RecipeRead[]
  freshness: readonly SourceFreshness[]
  /** Disagreements between sources: shown, never resolved. */
  contradictions: readonly GatheredContradiction[]
  /** Contested facts read whose other side is not known. */
  contestedFacts: readonly string[]
  /** Evidence left out because its source says it is gone. */
  removedEvidence: readonly string[]
  /** What the gates need to know of the sources read. */
  context: {
    evidence: Readonly<Record<string, EvidenceAudience>>
    facts: Readonly<Record<string, FactAudience>>
    freshness: FreshnessContext
    /**
     * Whose data each tracker of the project holds, by source id, when the run was gathered:
     * a work item of a tracker that is not the client's is internal data in a client document.
     */
    trackers?: Readonly<Record<string, SourceAudience>>
    /**
     * What the PM should know of how each data block was read (by block id), shown with the
     * red-team as warnings: a tracker left out, a sprint with no work item.
     */
    remarks?: Readonly<Record<string, readonly BlockRemark[]>>
  }
}
