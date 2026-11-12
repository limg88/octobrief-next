import { type Audience, type DocumentKind, isInternalOnly } from '../classification.ts'
import { DomainError } from '../errors.ts'
import type { FactKind } from '../knowledge.ts'
import type { Lang } from '../language/index.ts'
import {
  DATA_CATEGORIES,
  type DataCategory,
  DWSI_COLUMN_CATEGORIES,
  isMoreRestrictive,
  MOST_RESTRICTIVE_CATEGORY,
  sourceColumnCategory,
  TRACKER_FIELD_CATEGORIES,
} from '../recipe/categories.ts'
import type { CheckClass } from '../recipe/checks.ts'
import {
  type DeliverableDocument,
  type DocumentBlock,
  type DocumentCell,
  type DocumentSection,
  type DocumentSegment,
  type DocumentSourceRef,
  documentSchema,
} from '../recipe/document-model.ts'
import {
  type Recipe,
  type RecipeBlock,
  type RecipeSection,
  TITLE_PLACEHOLDER,
} from '../recipe/format.ts'
import { canonicalHash, canonicalJson } from '../recipe/hash.ts'
import { recipeDictionary, recipeText } from '../recipe/messages/index.ts'
import { effectiveCategory } from '../recipe/validate.ts'
import { columnsReadFrom } from '../recipe/warehouse-columns.ts'
import type { SourceAudience } from '../search.ts'
import {
  type Acceptance,
  type AcceptanceRefusal,
  isAcceptableCode,
  isAccepted,
} from './acceptance.ts'
import { type ClientPolicy, clientTreatment } from './client-policy.ts'
import {
  type ClientSourceClass,
  clientSourceClass,
  clientSourceNoteLabel,
} from './client-source-note.ts'
import { hasForeignLetters, internalTermsIn } from './internal-lexicon.ts'

// The separation between the internal and the client version of a deliverable, by category of
// data. Two layers, kept apart:
// - the evidence keeps its own audience: an economics extraction stays internal as a document
//   (`isInternalOnly`), whatever the client version shows of it;
// - the client version is an explicit projection of the internal document: internal sections and
//   notes never enter it, source notes become generic, and a value, a column or a text enters
//   only when every category it is made of is admitted for the client, or when the PM accepted
//   that very content with «Accetta così».
// The gate (`checkAudience`) admits every element by the categories it recomputes from the
// recipe and from the cited sources, never by the categories the document declares: those are
// checked against the recomputed ones, and a document that disagrees is refused. In text, the
// words of the organization (cost, rate, margin, estimated days) find what the sources do not
// reveal: that part is a heuristic.

export const AUDIENCE_GATE = 5
export const AUDIENCE_GATE_CLASS: CheckClass = 'data'

export type InternalDocument = Extract<DeliverableDocument, { audience: 'internal' }>
export type ClientDocument = Extract<DeliverableDocument, { audience: 'client' }>

/** A source note of the client version and the places it stands for, which the file never shows. */
export interface ClientNoteTrace {
  n: number
  refs: readonly DocumentSourceRef[]
}

/** The client version: the document for the file, and where each of its notes comes from. */
export interface ClientVersion {
  document: ClientDocument
  notes: readonly ClientNoteTrace[]
  /**
   * Every place each computed value reads, from the internal document (all the rows it counts
   * or totals, not only the notes it cites): the gate judges a value by all of them. `complete`
   * is false when a row it reads cites no place.
   */
  values: readonly ClientValueTrace[]
}

/** The places a computed value of the document reads, never shown in the file. */
export interface ClientValueTrace {
  block: string
  refs: readonly DocumentSourceRef[]
  complete: boolean
}

/** What the gate knows of a piece of evidence the document cites. */
export interface EvidenceAudience {
  kind: DocumentKind
  audience: Audience
  /** A source system gave it (the data warehouse, an export of a connector). */
  fromSystem: boolean
  title: string
}

/** What the gate knows of a fact the document cites. */
export interface FactAudience {
  kind: FactKind
  /** Every source of the fact is for the client. */
  clientOnly: boolean
}

export interface AudienceContext {
  recipe: Recipe
  policy: ClientPolicy
  evidence: Readonly<Record<string, EvidenceAudience>>
  facts: Readonly<Record<string, FactAudience>>
  /** The values of the parameters as titles show them, by id of the parameter. */
  parameters: Readonly<Record<string, string>>
  /**
   * Whose data each tracker holds, by source id: a work item (or a count) of a tracker that is
   * not the client's, or of one not listed, is internal data.
   */
  trackers?: Readonly<Record<string, SourceAudience>>
}

/** The place of a finding in the client version: ids of the recipe, never note numbers. */
export type AudienceRef =
  | { element: 'document_title' }
  | { element: 'internal_notes' }
  | { element: 'section'; section: string }
  | { element: 'section_title'; section: string }
  | { element: 'block_title'; section: string; block: string }
  | { element: 'column'; section: string; block: string; column: string }
  | { element: 'value'; section: string; block: string }
  /** `segment` is the fingerprint of its text and nature. */
  | { element: 'segment'; section: string; block: string; segment: string }
  | { element: 'source_note'; label: string }

/** Titles of where a finding is, for the text the PM reads. */
export interface AudiencePlace {
  section?: string
  block?: string
  column?: string
}

export type AudienceAnomalyCode =
  | 'internal_data_in_client'
  | 'internal_note_in_client'
  | 'internal_section_in_client'
  | 'client_source_note_not_generic'
  | 'mixed_script_in_client'

export interface AudienceAnomaly {
  code: AudienceAnomalyCode
  gate: typeof AUDIENCE_GATE
  class: CheckClass
  ref: AudienceRef
  refKey: string
  contentHash: string
  place: AudiencePlace
  /** The internal categories found, in the order of the categories. */
  categories: DataCategory[]
  /** The words of the organization found in the text. */
  terms: string[]
  /** The element takes from internal evidence or an internal fact. */
  internalSource: boolean
  acceptable: boolean
  status: 'open' | 'accepted'
}

/** Story points in a client version: never an anomaly, a warning the PM confirms explicitly. */
export interface AudienceWarning {
  code: 'story_points_in_client'
  gate: typeof AUDIENCE_GATE
  ref: AudienceRef
  refKey: string
  contentHash: string
  place: AudiencePlace
  terms: string[]
  requiresConfirmation: true
}

export interface AudienceReport {
  /** Elements checked. */
  checks: number
  anomalies: AudienceAnomaly[]
  warnings: AudienceWarning[]
}

const inconsistent = (reason: string): DomainError =>
  new DomainError('client_version_inconsistent', { reason })

const sortCategories = (cs: Iterable<DataCategory>): DataCategory[] => {
  const set = new Set(cs)
  return DATA_CATEGORIES.filter((c) => set.has(c))
}

// Categories recomputed from the sources and the recipe ------------------------------------------

/**
 * What a cited source may hold, recomputed from the place it cites: a row of a view of the
 * warehouse any category of the columns the recipe reads from the view (every column when it
 * reads none); a field of a work item its category; a work item
 * as a whole its identity and state; a piece of evidence the most restrictive category unless
 * it is for the client and not internal by kind; a fact by its kind and sources; a parameter of
 * the PM project data.
 */
export function sourceRefCategories(
  ref: DocumentSourceRef,
  ctx: Pick<AudienceContext, 'evidence' | 'facts'> & { recipe?: Recipe },
): DataCategory[] {
  switch (ref.kind) {
    case 'system_row': {
      const view = Object.hasOwn(DWSI_COLUMN_CATEGORIES, ref.view)
        ? DWSI_COLUMN_CATEGORIES[ref.view]
        : undefined
      if (!view) return [MOST_RESTRICTIVE_CATEGORY]
      // With the recipe, a cited row is worth every column any block of the recipe reads from its
      // view, whatever columns the citation names: a text citing one block's row could quote what
      // another block reads. Without the recipe (what a writer's source holds), the columns cited.
      const columns =
        ctx.recipe !== undefined ? columnsReadFrom(ctx.recipe, ref.view) : (ref.columns ?? [])
      if (columns.length === 0) return sortCategories(Object.values(view))
      return sortCategories(
        columns.map(
          (c) => (Object.hasOwn(view, c) ? view[c] : undefined) ?? MOST_RESTRICTIVE_CATEGORY,
        ),
      )
    }
    case 'work_item':
      if (ref.field === undefined) return ['other']
      return [
        Object.hasOwn(TRACKER_FIELD_CATEGORIES, ref.field)
          ? (TRACKER_FIELD_CATEGORIES[ref.field] as DataCategory)
          : MOST_RESTRICTIVE_CATEGORY,
      ]
    case 'work_item_counts':
      return ['other']
    case 'evidence': {
      const e = Object.hasOwn(ctx.evidence, ref.evidenceId) ? ctx.evidence[ref.evidenceId] : null
      if (!e) throw inconsistent('evidence_unknown')
      const internal = isInternalOnly(e.kind, e.fromSystem) || e.audience !== 'client'
      return [internal ? MOST_RESTRICTIVE_CATEGORY : 'other']
    }
    case 'fact': {
      const f = Object.hasOwn(ctx.facts, ref.factId) ? ctx.facts[ref.factId] : null
      if (!f) throw inconsistent('fact_unknown')
      return [
        sourceColumnCategory({
          source: 'facts',
          factKind: f.kind,
          field: 'statement',
          clientOnly: f.clientOnly,
        }),
      ]
    }
    case 'parameter':
      return ['other']
  }
}

/** Where the rows of a block of the recipe come from, as the refs of their notes say. */
function scopeOfRef(ref: DocumentSourceRef): string {
  switch (ref.kind) {
    case 'system_row':
      return `system_row:${ref.view}`
    case 'work_item':
    case 'work_item_counts':
      return 'tracker'
    default:
      return ref.kind
  }
}

/**
 * Where the rows of a block come from: a view, the tracker, facts, evidence, the PM. A selection
 * of the PM lists what was selected, so its rows cite the work items or the evidence selected.
 */
function scopeOfBlock(
  recipe: Recipe,
  block: Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>,
): string {
  const q = block.query
  switch (q.kind) {
    case 'system_rows':
      return `system_row:${q.view}`
    case 'facts':
      return 'fact'
    case 'parameter': {
      const type = recipe.parameters.find((p) => p.id === q.parameter)?.type
      if (type === 'work_item_selection') return 'tracker'
      if (type === 'evidence_selection') return 'evidence'
      return 'parameter'
    }
    default:
      return q.kind
  }
}

function recipeBlockById(recipe: Recipe, id: string): RecipeBlock {
  for (const s of recipe.sections) {
    const b = s.blocks.find((x) => x.id === id)
    if (b) return b
  }
  throw inconsistent('recipe_target_unknown')
}

/**
 * Where the sources of a computed value may come from: the rows of the block it counts or sums,
 * the sources of the values it is computed from, the PM for a parameter.
 */
function valueScopes(recipe: Recipe, id: string, seen: Set<string> = new Set()): Set<string> {
  const block = recipeBlockById(recipe, id)
  if (block.kind !== 'data_value' || seen.has(id)) throw inconsistent('recipe_target_unknown')
  seen.add(id)
  const rowsScope = (blockId: string) => {
    const b = recipeBlockById(recipe, blockId)
    if (b.kind !== 'data_table' && b.kind !== 'data_list')
      throw inconsistent('recipe_target_unknown')
    return scopeOfBlock(recipe, b)
  }
  const c = block.compute
  switch (c.op) {
    case 'count':
      return new Set([rowsScope(c.block)])
    case 'sum':
    case 'min':
    case 'max':
      return new Set([rowsScope(c.column.block)])
    case 'ratio':
    case 'difference': {
      const out = new Set<string>()
      for (const r of [c.left, c.right]) {
        if ('value' in r) for (const x of valueScopes(recipe, r.value, seen)) out.add(x)
        else out.add('parameter')
      }
      return out
    }
    case 'parameter':
      return new Set(['parameter'])
  }
}

/** Facts and evidence for the client only, as the recipe asks: checked on what was read. */
const isCheckedScope = (scope: string) => scope === 'fact' || scope === 'evidence'

/** A tracker the PM did not say is the client's makes whatever cites it internal. */
const isTrackerScope = (scope: string) => scope === 'tracker'

function effective(recipe: Recipe, block: string, column?: string): DataCategory {
  const c = effectiveCategory(recipe, block, column)
  if (c === null) throw inconsistent('recipe_target_unknown')
  return c
}

/** The categories a cell of a column is made of: its column, or the two operand columns. */
function columnOperands(
  recipe: Recipe,
  block: Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>,
  columnId: string,
): DataCategory[] {
  const column = block.columns.find((c) => c.id === columnId)
  if (!column) throw inconsistent('column_unknown')
  if (column.from.kind === 'field') return [effective(recipe, block.id, column.id)]
  return [
    effective(recipe, block.id, column.from.left),
    effective(recipe, block.id, column.from.right),
  ]
}

/** The categories a computed value is made of, one per operand. */
function valueOperands(
  recipe: Recipe,
  block: Extract<RecipeBlock, { kind: 'data_value' }>,
): DataCategory[] {
  const c = block.compute
  switch (c.op) {
    case 'count':
      return ['other']
    case 'sum':
    case 'min':
    case 'max':
      return [effective(recipe, c.column.block, c.column.column)]
    case 'ratio':
    case 'difference':
      return [c.left, c.right].map((r) =>
        'value' in r ? effective(recipe, r.value) : ('other' as DataCategory),
      )
    case 'parameter':
      return [effective(recipe, block.id)]
  }
}

/** A declared category stands for a recomputed one when it is the same or more restrictive. */
const standsFor = (declared: DataCategory, recomputed: DataCategory) =>
  declared === recomputed || isMoreRestrictive(declared, recomputed)

/**
 * A declared category of a source is plausible when the source may hold it, or when it is more
 * restrictive than all the source may hold. A source worth only the most restrictive category
 * (internal evidence, an unmapped column) may hold anything: every declaration is plausible, and
 * admission goes by the most restrictive category all the same.
 */
const plausibleFor = (declared: DataCategory, held: readonly DataCategory[]) =>
  held.includes(declared) ||
  held.every((h) => isMoreRestrictive(declared, h)) ||
  (held.length === 1 && held[0] === MOST_RESTRICTIVE_CATEGORY)

function recipeSectionOf(recipe: Recipe, id: string): RecipeSection {
  const s = recipe.sections.find((x) => x.id === id)
  if (!s) throw inconsistent('section_unknown')
  return s
}

function recipeBlockOf(section: RecipeSection, id: string): RecipeBlock {
  const b = section.blocks.find((x) => x.id === id)
  if (!b) throw inconsistent('block_unknown')
  return b
}

const isClientSection = (recipeSection: RecipeSection, section: DocumentSection) =>
  recipeSection.version !== 'internal' && section.version !== 'internal'

// The gate ----------------------------------------------------------------------------------------

/** What every place a computed value reads may hold. */
interface ValueRead {
  held: DataCategory[]
  internalSource: boolean
  scopes: Set<string>
}

interface NoteInfo {
  label: string
  held: DataCategory[]
  scopes: Set<string>
  internalSource: boolean
}

/**
 * Whether a source is internal as a whole: internal evidence, a fact of internal sources, a work
 * item or the counts of a tracker the PM did not say is the client's.
 */
function isInternalSource(
  ref: DocumentSourceRef,
  ctx: Pick<AudienceContext, 'evidence' | 'facts' | 'trackers'>,
): boolean {
  if (ref.kind === 'work_item' || ref.kind === 'work_item_counts') {
    const trackers = ctx.trackers ?? {}
    return !(Object.hasOwn(trackers, ref.sourceId) && trackers[ref.sourceId] === 'client')
  }
  if (ref.kind === 'evidence') {
    return sourceRefCategories(ref, ctx)[0] === MOST_RESTRICTIVE_CATEGORY
  }
  if (ref.kind === 'fact') {
    const f = Object.hasOwn(ctx.facts, ref.factId) ? ctx.facts[ref.factId] : undefined
    return f !== undefined && f.kind !== 'person' && (f.kind === 'economics' || !f.clientOnly)
  }
  return false
}

class Judge {
  checks = 0
  readonly anomalies: AudienceAnomaly[] = []
  readonly warnings: AudienceWarning[] = []

  private readonly policy: ClientPolicy
  private readonly lang: Lang
  private readonly acceptances: readonly Acceptance[]

  constructor(policy: ClientPolicy, lang: Lang, acceptances: readonly Acceptance[]) {
    this.policy = policy
    this.lang = lang
    this.acceptances = acceptances
  }

  /** An anomaly the code itself excludes, whatever the categories. */
  fixed(code: AudienceAnomalyCode, ref: AudienceRef, content: unknown, place: AudiencePlace) {
    this.push(code, ref, canonicalHash(content), place, [], [], false)
  }

  /** Judges an element by the categories it is made of and the words of its texts. */
  judge(
    ref: AudienceRef,
    content: unknown,
    place: AudiencePlace,
    categories: Iterable<DataCategory>,
    texts: readonly string[],
    internalSource = false,
  ): void {
    this.checks++
    const hits = texts.flatMap((t) => internalTermsIn(t, this.lang))
    const all = [...categories, ...hits.map((h) => h.category)]
    const internal = sortCategories(
      all.filter((c) => clientTreatment(this.policy, c) === 'internal'),
    )
    const storyPoints = all.some((c) => clientTreatment(this.policy, c) === 'story_points')
    const mixed = texts.some((t) => hasForeignLetters(t, this.lang))
    if (internal.length === 0 && !storyPoints && !internalSource && !mixed) return
    const hash = canonicalHash(content)
    // Letters of another alphabet inside a word can hide a word of the lexicon («cоsto»).
    if (mixed) this.push('mixed_script_in_client', ref, hash, place, [], [], false)
    const terms = (cs: (c: DataCategory) => boolean) => [
      ...new Set(hits.filter((h) => cs(h.category)).map((h) => h.term)),
    ]
    if (internal.length > 0 || internalSource) {
      this.push(
        'internal_data_in_client',
        ref,
        hash,
        place,
        internal,
        terms((c) => internal.includes(c)),
        internalSource,
      )
    }
    if (storyPoints) {
      this.warnings.push({
        code: 'story_points_in_client',
        gate: AUDIENCE_GATE,
        ref,
        refKey: canonicalJson(ref),
        contentHash: hash,
        place,
        terms: terms((c) => c === 'story_points'),
        requiresConfirmation: true,
      })
    }
  }

  private push(
    code: AudienceAnomalyCode,
    ref: AudienceRef,
    contentHash: string,
    place: AudiencePlace,
    categories: DataCategory[],
    terms: string[],
    internalSource: boolean,
  ): void {
    const refKey = canonicalJson(ref)
    const anomaly = { code, refKey, contentHash }
    this.anomalies.push({
      code,
      gate: AUDIENCE_GATE,
      class: AUDIENCE_GATE_CLASS,
      ref,
      refKey,
      contentHash,
      place,
      categories,
      terms,
      internalSource,
      acceptable: isAcceptableCode(code),
      status: isAccepted(anomaly, this.acceptances) ? 'accepted' : 'open',
    })
  }
}

/**
 * Gate 5 on a client version: every title, column, value, text and source note, each admitted
 * by the categories recomputed from the recipe and from the places its notes cite, plus the
 * words of the organization in its texts. Each element with an internal category is one
 * `internal_data_in_client` anomaly (a whole column is one element), which the PM can accept;
 * story points give the `story_points_in_client` warning instead. Internal notes, internal
 * sections and source notes that are not generic are anomalies nobody can accept.
 *
 * Throws `client_version_inconsistent` when the version does not match its recipe or its
 * sources: a block or a column the recipe does not have, declared categories that do not stand
 * for the recomputed ones, a note without its places, a source the context does not know, or
 * places read by its computed values (`values`) that differ from what the internal document the
 * version comes from says: the gate recomputes them from that document and the recipe.
 */
export function checkAudience(
  version: ClientVersion,
  ctx: AudienceContext,
  internal: DeliverableDocument,
  acceptances: readonly Acceptance[] = [],
): AudienceReport {
  const raw = version.document as DeliverableDocument
  if (raw.audience !== 'client') throw inconsistent('not_a_client_version')
  const source = documentSchema.safeParse(internal)
  if (!source.success || source.data.audience !== 'internal') {
    throw inconsistent('not_an_internal_document')
  }
  if (
    source.data.recipe.slug !== ctx.recipe.slug ||
    source.data.recipe.version !== ctx.recipe.version
  ) {
    throw inconsistent('recipe_mismatch')
  }
  // What each computed value reads, recomputed: the version says the same, or it is not one.
  const recomputed = valueTraces(source.data, ctx.recipe)
  if (canonicalJson(recomputed) !== canonicalJson(version.values ?? null)) {
    throw inconsistent('value_reads')
  }
  const judge = new Judge(ctx.policy, raw.lang, acceptances)
  if (raw.internalNotes.length > 0) {
    judge.checks++
    judge.fixed('internal_note_in_client', { element: 'internal_notes' }, raw.internalNotes, {})
  }
  const parsed = documentSchema.safeParse({ ...raw, internalNotes: [] })
  if (!parsed.success || parsed.data.audience !== 'client') throw inconsistent('malformed')
  const doc = parsed.data
  if (
    doc.recipe.slug !== ctx.recipe.slug ||
    doc.recipe.version !== ctx.recipe.version ||
    doc.recipe.title !== ctx.recipe.title
  ) {
    throw inconsistent('recipe_mismatch')
  }
  const title = (t: string) => fillTitle(t, ctx.parameters, doc.lang)
  if (doc.title !== title(ctx.recipe.title)) throw inconsistent('title_changed')

  // Source notes: each with its places, all of one class and scope, in the generic form.
  const traces = new Map<number, readonly DocumentSourceRef[]>()
  for (const t of version.notes) {
    if (t.refs.length === 0 || traces.has(t.n)) throw inconsistent('note_trace')
    traces.set(t.n, t.refs)
  }
  if (traces.size !== doc.sourceNotes.length) throw inconsistent('note_trace')
  const internalTitles = new Set(Object.values(ctx.evidence).map((e) => e.title))
  const notes = new Map<number, NoteInfo>()
  for (const note of doc.sourceNotes) {
    const refs = traces.get(note.n)
    if (refs === undefined || notes.has(note.n)) throw inconsistent('note_trace')
    const classes = new Set<ClientSourceClass>(refs.map(clientSourceClass))
    const scopes = new Set(refs.map(scopeOfRef))
    if (classes.size !== 1 || scopes.size !== 1) throw inconsistent('note_trace')
    const held = sortCategories(refs.flatMap((r) => sourceRefCategories(r, ctx)))
    const internalSource = refs.some((r) => isInternalSource(r, ctx))
    notes.set(note.n, { label: note.label, held, scopes, internalSource })
    judge.checks++
    const expected = clientSourceNoteLabel(
      [...classes][0] as ClientSourceClass,
      note.dataAsOf,
      doc.lang,
    )
    if (note.label !== expected || internalTitles.has(note.label)) {
      judge.fixed(
        'client_source_note_not_generic',
        { element: 'source_note', label: note.label },
        note,
        {},
      )
    }
  }
  const noteOf = (n: number): NoteInfo => {
    const info = notes.get(n)
    if (!info) throw inconsistent('note_unknown')
    return info
  }
  const labelsOf = (ns: readonly number[]) => ns.map((n) => noteOf(n).label)
  const valueTraceMap = new Map<string, ClientValueTrace>()
  for (const t of recomputed) valueTraceMap.set(t.block, t)
  const valueReads = (id: string): ValueRead | null => {
    const t = valueTraceMap.get(id)
    if (!t) return null
    const read: ValueRead = { held: [], internalSource: !t.complete, scopes: new Set() }
    for (const ref of t.refs) {
      const scope = scopeOfRef(ref)
      read.scopes.add(scope)
      // Every work item a value counts, not only those its cell cites (at most 20).
      if (isTrackerScope(scope)) {
        read.internalSource ||= isInternalSource(ref, ctx)
        continue
      }
      if (!isCheckedScope(scope)) continue
      read.held.push(...sourceRefCategories(ref, ctx))
      read.internalSource ||= isInternalSource(ref, ctx)
    }
    return read
  }

  judge.judge({ element: 'document_title' }, { text: doc.title }, {}, [], [doc.title])

  for (const section of doc.sections) {
    const rs = recipeSectionOf(ctx.recipe, section.id)
    const place: AudiencePlace = { section: section.title }
    if (!isClientSection(rs, section)) {
      judge.checks++
      judge.fixed(
        'internal_section_in_client',
        { element: 'section', section: section.id },
        section,
        place,
      )
      continue
    }
    if (rs.version !== section.version) throw inconsistent('section_version')
    if (section.title !== title(rs.title)) throw inconsistent('title_changed')
    judge.judge(
      { element: 'section_title', section: section.id },
      { text: section.title },
      place,
      [],
      [section.title],
    )
    for (const block of section.blocks) {
      checkBlock(judge, ctx.recipe, rs, section, block, noteOf, labelsOf, title, valueReads)
    }
  }
  return { checks: judge.checks, anomalies: judge.anomalies, warnings: judge.warnings }
}

function checkBlock(
  judge: Judge,
  recipe: Recipe,
  rs: RecipeSection,
  section: DocumentSection,
  block: DocumentBlock,
  noteOf: (n: number) => NoteInfo,
  labelsOf: (ns: readonly number[]) => string[],
  title: (t: string) => string,
  valueReads: (id: string) => ValueRead | null,
): void {
  const rb = recipeBlockOf(rs, block.id)
  // Titles are the recipe's, with the values of the parameters: never written elsewhere.
  const sameTitle = (doc: string | undefined, recipe: string | undefined) =>
    doc === (recipe === undefined ? undefined : title(recipe))
  const s = section.id
  switch (block.kind) {
    case 'static':
      if (rb.kind !== 'static' || rb.text !== block.text) throw inconsistent('static_changed')
      judge.checks++
      return
    case 'text': {
      if (rb.kind !== 'text_slot') throw inconsistent('block_kind')
      if (!sameTitle(block.title, rb.title)) throw inconsistent('title_changed')
      const place: AudiencePlace = { section: section.title }
      if (block.title !== undefined) {
        judge.judge(
          { element: 'block_title', section: s, block: block.id },
          { text: block.title },
          { ...place, block: block.title },
          [],
          [block.title],
        )
      }
      for (const seg of block.segments) {
        const { ref, content, categories } = segmentFacts(s, block.id, seg, noteOf, labelsOf)
        const internalSource = seg.sources.some((n) => noteOf(n).internalSource)
        judge.judge(ref, content, place, categories, [seg.text], internalSource)
      }
      return
    }
    case 'value': {
      if (rb.kind !== 'data_value' || !sameTitle(block.label, rb.label)) {
        throw inconsistent('block_kind')
      }
      const categories = cellCategories(block.cell, valueOperands(recipe, rb))
      const scopes = valueScopes(recipe, rb.id)
      let internalSource = false
      for (const n of block.cell.sources) {
        const note = noteOf(n)
        const scope = [...note.scopes][0] as string
        if (!scopes.has(scope)) throw inconsistent('value_source_scope')
        if (block.cell.text !== null && isCheckedScope(scope)) {
          categories.push(...note.held)
          internalSource ||= note.internalSource
        }
        if (block.cell.text !== null && isTrackerScope(scope)) {
          internalSource ||= note.internalSource
        }
      }
      if (block.cell.text !== null) {
        categories.push(effective(recipe, rb.id))
        // Judged by every place it reads, not only the notes it cites (a cell cites at most 20).
        const read = valueReads(rb.id)
        if (read === null) throw inconsistent('value_reads')
        for (const scope of read.scopes) {
          if (!scopes.has(scope)) throw inconsistent('value_source_scope')
        }
        categories.push(...read.held)
        internalSource ||= read.internalSource
      }
      judge.judge(
        { element: 'value', section: s, block: block.id },
        { label: block.label, cell: cellContent(block.cell, labelsOf) },
        { section: section.title, block: block.label },
        categories,
        [block.label, block.cell.text ?? ''],
        internalSource,
      )
      return
    }
    case 'table':
    case 'list': {
      const kind = block.kind === 'table' ? 'data_table' : 'data_list'
      if (rb.kind !== kind) throw inconsistent('block_kind')
      if (!sameTitle(block.title, rb.title)) throw inconsistent('title_changed')
      const rows = block.kind === 'table' ? block.rows : block.items
      const ids = block.columns.map((c) => c.id)
      if (new Set(ids).size !== ids.length) throw inconsistent('column_duplicate')
      for (const row of rows) {
        if (row.cells.length !== block.columns.length) throw inconsistent('row_width')
      }
      const scope = scopeOfBlock(recipe, rb)
      // A row key is made of its key cells, as they are in this version, or is its position.
      const expectedKeys = rowKeysOf(
        rb,
        ids,
        rows.map((row) => row.cells),
      )
      rows.forEach((row, r) => {
        if (row.key !== expectedKeys[r]) throw inconsistent('row_key')
      })
      const keyColumns = new Set(rb.key ?? [])
      const place: AudiencePlace = { section: section.title }
      if (block.title !== undefined) {
        place.block = block.title
        judge.judge(
          { element: 'block_title', section: s, block: block.id },
          { text: block.title },
          place,
          [],
          [block.title],
        )
      }
      block.columns.forEach((column, i) => {
        const rc = rb.columns.find((c) => c.id === column.id)
        if (!rc || !sameTitle(column.title, rc.title)) throw inconsistent('column_unknown')
        const operands = columnOperands(recipe, rb, column.id)
        const categories: DataCategory[] = []
        const texts = [column.title]
        const isKey = keyColumns.has(column.id)
        let internalSource = false
        // A key column is judged by its categories even when its cells are empty: the key of
        // the row is made of it.
        if (isKey)
          categories.push(...operands, column.category, effective(recipe, rb.id, column.id))
        for (const row of rows) {
          const cell = row.cells[i] as DocumentCell
          for (const n of cell.sources) {
            if (!noteOf(n).scopes.has(scope)) throw inconsistent('cell_source_scope')
          }
          if (isKey) categories.push(cell.category, ...cell.operandCategories)
          if (cell.text === null) {
            cellCategories(cell, operands)
            continue
          }
          categories.push(...cellCategories(cell, operands), column.category)
          categories.push(effective(recipe, rb.id, column.id))
          texts.push(cell.text)
          if (isCheckedScope(scope)) {
            for (const n of cell.sources) {
              const note = noteOf(n)
              categories.push(...note.held)
              internalSource ||= note.internalSource
            }
          }
          if (isTrackerScope(scope)) {
            for (const n of cell.sources) internalSource ||= noteOf(n).internalSource
          }
        }
        judge.judge(
          { element: 'column', section: s, block: block.id, column: column.id },
          {
            title: column.title,
            // The row key belongs to the key columns; the others go by position.
            cells: rows.map((r, n) => ({
              row: isKey ? r.key : n,
              ...cellContent(r.cells[i] as DocumentCell, labelsOf),
            })),
          },
          { ...place, column: column.title },
          categories,
          texts,
          internalSource,
        )
      })
      return
    }
  }
}

/** The key of a row that cannot have one made of its cells: its position, from 1. */
const ordinalKey = (index: number) => String(index + 1)

/** Longest row key the document admits. */
const MAX_ROW_KEY = 1_000

/**
 * The key of a row, made of the texts of its key cells in the order of the recipe's key: their
 * canonical JSON, or its hash when that is too long. Null when there are no key cells or one is
 * empty: the row then has no key of its own. The internal document builds its keys the same way.
 */
export function rowKeyOf(keyCells: readonly (string | null)[]): string | null {
  if (keyCells.length === 0 || keyCells.some((t) => t === null)) return null
  const key = canonicalJson(keyCells)
  return key.length <= MAX_ROW_KEY ? key : canonicalHash(keyCells)
}

/**
 * The keys of the rows of a block of the client version: each made of the key cells it shows,
 * or its position when the recipe declares no key, a key column is not shown or a key cell is
 * empty. Rows whose keys would be the same all take their positions: a key identifies one row.
 * Never the key of the internal document, which is built the same way.
 */
export function rowKeysOf(
  block: Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>,
  columnIds: readonly string[],
  rows: readonly (readonly DocumentCell[])[],
): string[] {
  const own = rows.map((cells) =>
    rowKeyOf(
      (block.key ?? []).map((k) => {
        const i = columnIds.indexOf(k)
        return i < 0 ? null : (cells[i]?.text ?? null)
      }),
    ),
  )
  const seen = new Map<string, number>()
  for (const k of own) if (k !== null) seen.set(k, (seen.get(k) ?? 0) + 1)
  return own.map((k, i) => (k !== null && seen.get(k) === 1 ? k : ordinalKey(i)))
}

/**
 * A title of the recipe with the values of its parameters (`{{id}}`); a parameter without a
 * value is «non dedotto». The internal document fills its titles the same way.
 */
export function fillTitle(
  title: string,
  parameters: Readonly<Record<string, string>>,
  lang: Lang,
): string {
  return title.replace(TITLE_PLACEHOLDER, (_, id: string) =>
    Object.hasOwn(parameters, id)
      ? (parameters[id] as string)
      : recipeText('audience', 'parameter_not_deduced', {}, lang),
  )
}

/** The categories a cell is admitted by: declared operands checked against the recomputed ones. */
function cellCategories(cell: DocumentCell, recomputed: readonly DataCategory[]): DataCategory[] {
  if (cell.operandCategories.length !== recomputed.length) throw inconsistent('operand_categories')
  cell.operandCategories.forEach((d, i) => {
    if (!standsFor(d, recomputed[i] as DataCategory)) throw inconsistent('operand_categories')
  })
  if (cell.text === null) return []
  return [...cell.operandCategories, ...recomputed, cell.category]
}

function cellContent(cell: DocumentCell, labelsOf: (ns: readonly number[]) => string[]) {
  return {
    text: cell.text,
    category: cell.category,
    operandCategories: cell.operandCategories,
    notes: labelsOf(cell.sources),
  }
}

function segmentFacts(
  section: string,
  block: string,
  seg: DocumentSegment,
  noteOf: (n: number) => NoteInfo,
  labelsOf: (ns: readonly number[]) => string[],
) {
  if (seg.sourceCategories.length !== seg.sources.length) throw inconsistent('source_categories')
  const categories: DataCategory[] = [seg.category]
  seg.sources.forEach((n, i) => {
    const declared = seg.sourceCategories[i] as DataCategory
    const { held } = noteOf(n)
    if (!plausibleFor(declared, held)) throw inconsistent('source_categories')
    categories.push(declared, ...held)
  })
  const ref: AudienceRef = {
    element: 'segment',
    section,
    block,
    segment: canonicalHash({ text: seg.text, nature: seg.nature }),
  }
  const content = {
    text: seg.text,
    nature: seg.nature,
    category: seg.category,
    sourceCategories: seg.sourceCategories,
    notes: labelsOf(seg.sources),
  }
  return { ref, content, categories }
}

// The projection ----------------------------------------------------------------------------------

interface ClientNoteDraft {
  n: number
  label: string
  dataAsOf: string | null
  refs: DocumentSourceRef[]
}

/** The client notes, numbered by first citation: one per class, day, scope and categories held. */
class NoteBuilder {
  private readonly byKey = new Map<string, ClientNoteDraft>()
  private readonly drafts: ClientNoteDraft[] = []

  private readonly internal: ReadonlyMap<number, InternalDocument['sourceNotes'][number]>
  private readonly ctx: AudienceContext
  private readonly lang: Lang

  constructor(
    internal: ReadonlyMap<number, InternalDocument['sourceNotes'][number]>,
    ctx: AudienceContext,
    lang: Lang,
  ) {
    this.internal = internal
    this.ctx = ctx
    this.lang = lang
  }

  map(n: number): number {
    const note = this.internal.get(n)
    if (!note) throw inconsistent('note_unknown')
    const label = clientSourceNoteLabel(clientSourceClass(note.ref), note.dataAsOf, this.lang)
    const key = canonicalJson({
      label,
      scope: scopeOfRef(note.ref),
      held: sourceRefCategories(note.ref, this.ctx),
    })
    let draft = this.byKey.get(key)
    if (!draft) {
      draft = { n: this.drafts.length + 1, label, dataAsOf: note.dataAsOf, refs: [] }
      this.byKey.set(key, draft)
      this.drafts.push(draft)
    }
    if (!draft.refs.some((r) => canonicalJson(r) === canonicalJson(note.ref))) {
      draft.refs.push(note.ref)
    }
    // The same day: the oldest instant stands for the note.
    if (draft.dataAsOf !== null && note.dataAsOf !== null) {
      if (Date.parse(note.dataAsOf) < Date.parse(draft.dataAsOf)) draft.dataAsOf = note.dataAsOf
    }
    return draft.n
  }

  notes(): { sourceNotes: ClientDocument['sourceNotes']; traces: ClientNoteTrace[] } {
    return {
      sourceNotes: this.drafts.map((d) => ({ n: d.n, label: d.label, dataAsOf: d.dataAsOf })),
      traces: this.drafts.map((d) => ({ n: d.n, refs: d.refs })),
    }
  }
}

const unique = (ns: readonly number[]) => [...new Set(ns)]

function projectCell(cell: DocumentCell, notes: NoteBuilder): DocumentCell {
  return { ...structuredClone(cell), sources: unique(cell.sources.map((n) => notes.map(n))) }
}

function projectSegment(seg: DocumentSegment, notes: NoteBuilder): DocumentSegment {
  const entries = new Map<string, [number, DataCategory]>()
  seg.sources.forEach((n, i) => {
    const m = notes.map(n)
    const c = seg.sourceCategories[i] as DataCategory
    entries.set(`${m}:${c}`, [m, c])
  })
  const pairs = [...entries.values()]
  return {
    text: seg.text,
    nature: seg.nature,
    category: seg.category,
    sources: pairs.map(([m]) => m),
    sourceCategories: pairs.map(([, c]) => c),
  }
}

/** The client version without the elements in `withheld` (keys of their refs). */
function buildClientVersion(
  doc: InternalDocument,
  ctx: AudienceContext,
  withheld: ReadonlySet<string>,
): ClientVersion {
  const internalNotes = new Map(doc.sourceNotes.map((n) => [n.n, n] as const))
  const notes = new NoteBuilder(internalNotes, ctx, doc.lang)
  const kept = (ref: AudienceRef) => !withheld.has(canonicalJson(ref))
  const sections: DocumentSection[] = []
  for (const section of doc.sections) {
    const rs = recipeSectionOf(ctx.recipe, section.id)
    if (!isClientSection(rs, section)) continue
    const blocks: DocumentBlock[] = []
    for (const block of section.blocks) {
      const s = section.id
      switch (block.kind) {
        case 'static':
          blocks.push(structuredClone(block))
          break
        case 'text':
          blocks.push({
            ...structuredClone(block),
            segments: block.segments
              .filter((seg) =>
                kept({
                  element: 'segment',
                  section: s,
                  block: block.id,
                  segment: canonicalHash({ text: seg.text, nature: seg.nature }),
                }),
              )
              .map((seg) => projectSegment(seg, notes)),
          })
          break
        case 'value':
          if (kept({ element: 'value', section: s, block: block.id })) {
            blocks.push({ ...structuredClone(block), cell: projectCell(block.cell, notes) })
          }
          break
        case 'table':
        case 'list': {
          const keep = block.columns.map((c) =>
            kept({ element: 'column', section: s, block: block.id, column: c.id }),
          )
          if (!keep.some(Boolean)) break
          const rb = recipeBlockOf(rs, block.id)
          if (rb.kind !== 'data_table' && rb.kind !== 'data_list') {
            throw inconsistent('block_kind')
          }
          const keptIds = block.columns.filter((_, i) => keep[i]).map((c) => c.id)
          const cellsOfRows = (block.kind === 'table' ? block.rows : block.items).map((r) =>
            r.cells.filter((_, i) => keep[i]).map((c) => projectCell(c, notes)),
          )
          const keys = rowKeysOf(rb, keptIds, cellsOfRows)
          const rows = cellsOfRows.map((cells, n) => ({ key: keys[n] as string, cells }))
          const columns = block.columns.filter((_, i) => keep[i]).map((c) => ({ ...c }))
          const base = {
            id: block.id,
            ...(block.title === undefined ? {} : { title: block.title }),
            columns,
            notDeduced: block.notDeduced,
          }
          blocks.push(
            block.kind === 'table'
              ? { kind: 'table', ...base, rows }
              : { kind: 'list', ...base, items: rows },
          )
          break
        }
      }
    }
    sections.push({
      id: section.id,
      title: section.title,
      version: section.version,
      notDeduced: section.notDeduced,
      blocks,
    })
  }
  const { sourceNotes, traces } = notes.notes()
  return {
    document: {
      schema: doc.schema,
      recipe: { ...doc.recipe },
      audience: 'client',
      lang: doc.lang,
      title: doc.title,
      header: { ...doc.header },
      sections,
      sourceNotes,
      internalNotes: [],
    },
    notes: traces,
    values: valueTraces(doc, ctx.recipe),
  }
}

/**
 * The places every computed value of the recipe reads in the internal document: the notes cited
 * by every row it counts (or by every cell of the column it totals), and those of the values it
 * is computed from. A row without any note, or a counted block missing from the document, makes
 * the trace incomplete: the value is then judged as taking from an internal source.
 */
export function valueTraces(doc: InternalDocument, recipe: Recipe): ClientValueTrace[] {
  const refOf = new Map(doc.sourceNotes.map((n) => [n.n, n.ref] as const))
  const rowsOf = (id: string) => {
    for (const s of doc.sections) {
      const b = s.blocks.find((x) => x.id === id)
      if (b?.kind === 'table') return { columns: b.columns, rows: b.rows }
      if (b?.kind === 'list') return { columns: b.columns, rows: b.items }
    }
    return null
  }
  const cells = (blockId: string, columnId?: string): { refs: number[]; complete: boolean } => {
    const found = rowsOf(blockId)
    if (!found) return { refs: [], complete: false }
    const index = columnId === undefined ? -1 : found.columns.findIndex((c) => c.id === columnId)
    if (columnId !== undefined && index < 0) return { refs: [], complete: false }
    const refs: number[] = []
    let complete = true
    for (const row of found.rows) {
      const chosen = index < 0 ? row.cells : [row.cells[index] as DocumentCell]
      const cited = chosen.flatMap((c) => c.sources)
      if (cited.length === 0 && chosen.some((c) => c.text !== null || index < 0)) complete = false
      refs.push(...cited)
    }
    return { refs, complete }
  }
  const memo = new Map<string, { refs: number[]; complete: boolean }>()
  const reads = (id: string, seen: Set<string>): { refs: number[]; complete: boolean } => {
    const known = memo.get(id)
    if (known) return known
    let b: RecipeBlock | undefined
    for (const s of recipe.sections) b ??= s.blocks.find((x) => x.id === id)
    if (b?.kind !== 'data_value' || seen.has(id)) return { refs: [], complete: false }
    seen.add(id)
    const c = b.compute
    let out: { refs: number[]; complete: boolean }
    switch (c.op) {
      case 'count':
        out = cells(c.block)
        break
      case 'sum':
      case 'min':
      case 'max':
        out = cells(c.column.block, c.column.column)
        break
      case 'ratio':
      case 'difference': {
        const parts = [c.left, c.right].map((r) =>
          'value' in r ? reads(r.value, seen) : { refs: [], complete: true },
        )
        out = {
          refs: parts.flatMap((p) => p.refs),
          complete: parts.every((p) => p.complete),
        }
        break
      }
      case 'parameter':
        out = { refs: [], complete: true }
        break
    }
    memo.set(id, out)
    return out
  }
  const out: ClientValueTrace[] = []
  for (const s of recipe.sections) {
    for (const b of s.blocks) {
      if (b.kind !== 'data_value') continue
      const r = reads(b.id, new Set())
      const refs = new Map<string, DocumentSourceRef>()
      let complete = r.complete
      for (const n of r.refs) {
        const ref = refOf.get(n)
        if (!ref) complete = false
        else refs.set(canonicalJson(ref), ref)
      }
      out.push({ block: b.id, refs: [...refs.values()], complete })
    }
  }
  return out
}

const WITHHELD_ELEMENTS: ReadonlySet<AudienceRef['element']> = new Set([
  'column',
  'value',
  'segment',
])

/**
 * The client version of an internal document, and the report of gate 5 on it. Internal sections
 * and internal notes never enter it; every source note becomes the generic class of the source
 * and its day. A column, a value or a text with an internal category stays out of the version
 * while its anomaly is open: it enters only with an acceptance of that very content. Story
 * points stay in, with their warning. The evidence keeps its own audience: projecting never
 * changes what an extraction is.
 *
 * Throws `recipe_not_for_client` for a recipe that produces only the internal version, and
 * `client_version_inconsistent` when the document does not match its recipe or its sources.
 */
export function projectClientVersion(
  internal: DeliverableDocument,
  ctx: AudienceContext,
  acceptances: readonly Acceptance[] = [],
): { version: ClientVersion; report: AudienceReport } {
  if (ctx.recipe.audience === 'internal') throw new DomainError('recipe_not_for_client')
  const parsed = documentSchema.safeParse(internal)
  if (!parsed.success || parsed.data.audience !== 'internal') {
    throw inconsistent('not_an_internal_document')
  }
  const doc = parsed.data
  if (doc.recipe.slug !== ctx.recipe.slug || doc.recipe.version !== ctx.recipe.version) {
    throw inconsistent('recipe_mismatch')
  }
  const candidate = buildClientVersion(doc, ctx, new Set())
  const report = checkAudience(candidate, ctx, doc, acceptances)
  const withheld = new Set(
    report.anomalies
      .filter((a) => a.status === 'open' && WITHHELD_ELEMENTS.has(a.ref.element))
      .map((a) => a.refKey),
  )
  const version = withheld.size === 0 ? candidate : buildClientVersion(doc, ctx, withheld)
  return { version, report }
}

// Texts for the PM ---------------------------------------------------------------------------------

export type AudienceTextKey =
  | AudienceAnomalyCode
  | 'internal_source_in_client'
  | 'internal_source_and_data_in_client'
  | 'story_points_in_client'
  | 'where_column'
  | 'where_column_untitled'
  | 'where_value'
  | 'where_segment'
  | 'where_block_title'
  | 'where_section_title'
  | 'where_document_title'
  | 'list_and'
  | 'parameter_not_deduced'
  | 'client_version_unavailable'

function whereKey(ref: AudienceRef, place: AudiencePlace): AudienceTextKey {
  switch (ref.element) {
    case 'column':
      return place.block === undefined ? 'where_column_untitled' : 'where_column'
    case 'value':
      return 'where_value'
    case 'segment':
      return 'where_segment'
    case 'block_title':
      return 'where_block_title'
    case 'section_title':
      return 'where_section_title'
    default:
      return 'where_document_title'
  }
}

/** The categories in words: «costi, tariffe e margini». */
function categoryList(categories: readonly DataCategory[], lang: Lang): string {
  const names = categories.map((c) => recipeDictionary(lang).categories[c])
  const last = names.pop()
  if (last === undefined) return ''
  if (names.length === 0) return last
  return [names.join(', '), recipeText('audience', 'list_and', {}, lang), last].join(' ')
}

/** The text the PM reads for a finding of the separation: where it is and what it contains. */
export function audienceFindingText(
  finding: AudienceAnomaly | AudienceWarning,
  lang: Lang,
): string {
  const place = {
    section: finding.place.section ?? '',
    block: finding.place.block ?? '',
    column: finding.place.column ?? '',
  }
  let code: AudienceTextKey = finding.code
  let categories: readonly DataCategory[] = 'categories' in finding ? finding.categories : []
  if ('internalSource' in finding && finding.internalSource) {
    // An internal source is worth the most restrictive category: say what it is instead.
    categories = categories.filter((c) => c !== MOST_RESTRICTIVE_CATEGORY)
    code =
      categories.length === 0 ? 'internal_source_in_client' : 'internal_source_and_data_in_client'
  }
  return recipeText(
    'audience',
    code,
    {
      where: recipeText('audience', whereKey(finding.ref, finding.place), place, lang),
      categories: categoryList(categories, lang),
      section: place.section,
    },
    lang,
  )
}

/** The text the PM reads when «Accetta così» is refused. */
export function acceptanceRefusalText(refusal: AcceptanceRefusal, lang: Lang): string {
  return recipeText('acceptance', refusal, {}, lang)
}
