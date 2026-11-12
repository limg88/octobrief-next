import type { AnswerParseError, AnswerSourceRef, ModelAnswer, Nature } from '../answer.ts'
import { NATURES, parseModelAnswer } from '../answer.ts'
import type { VerifiedAnswer, VerifiedSegment } from '../answer-check.ts'
import { DomainError } from '../errors.ts'
import { type AudienceContext, sourceRefCategories } from '../gate/audience.ts'
import type { FactId } from '../ids.ts'
import { LANGS, type Lang } from '../language/index.ts'
import { numbersIn } from '../numbers.ts'
import { detectSuspicious, type SuspiciousPattern } from '../suspicious.ts'
import { WORK_ITEM_FIELDS } from '../tracker.ts'
import { type DataCategory, mostRestrictiveOf } from './categories.ts'
import type {
  DeliverableDocument,
  DocumentCell,
  DocumentSkeleton,
  DocumentSourceRef,
} from './document-model.ts'
import type { Recipe, RecipeQuery } from './format.ts'
import type { SlotContent, SlotSegment, SlotSource } from './merge.ts'

// What the model writes in one text slot of a recipe, and how the code takes it. The model gets
// the data of the skeleton as context it may cite (by the number of a note) and never change:
// a number of a slot that is not what the skeleton shows for the note it cites has no source.
// It answers in a portable schema (shape only); counts, lengths and the natures a slot admits
// are enforced here. Only what the verifier checked enters the draft, and only its verified
// sources become sources of the draft.

export const SLOT_LIMITS = Object.freeze({
  segmentsMax: 20,
  internalNotesMax: 10,
  /** Rows of a table or a list the writer is shown; the rest is summarized by the code. */
  rowsShown: 200,
  /** Rows of a table or a list the reviewer reads; past it the red-team says it checked a sample. */
  rowsReviewed: 200,
})

/**
 * A note of the skeleton, cited by the writer, becomes a fact id of this form for the verifier:
 * real fact ids are UUIDs, so the two never meet.
 */
export const SKELETON_NOTE_PREFIX = 'skeleton-note:'

export const skeletonNoteFactId = (n: number): FactId => `${SKELETON_NOTE_PREFIX}${n}` as FactId

/** The note number behind a fact id of a skeleton note; null for a real fact. */
export function skeletonNoteOf(factId: string): number | null {
  if (!factId.startsWith(SKELETON_NOTE_PREFIX)) return null
  const n = Number(factId.slice(SKELETON_NOTE_PREFIX.length))
  return Number.isInteger(n) && n >= 1 ? n : null
}

const text = { type: 'string' } as const
const id = { type: 'string' } as const
const positive = { type: 'integer' } as const

const closed = <P extends Record<string, unknown>>(properties: P) =>
  ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }) as const

const locatorSchema = {
  anyOf: [
    closed({ kind: { enum: ['page'] }, page: positive }),
    closed({ kind: { enum: ['paragraph'] }, index: positive }),
    closed({ kind: { enum: ['slide'] }, slide: positive }),
    closed({ kind: { enum: ['cell'] }, sheet: { type: 'string' }, ref: { type: 'string' } }),
    closed({ kind: { enum: ['line'] }, from: positive, to: positive }),
  ],
} as const

const trackerLocatorSchema = {
  anyOf: [
    closed({ kind: { enum: ['work_item'] }, id }),
    closed({ kind: { enum: ['work_item'] }, id, field: { enum: [...WORK_ITEM_FIELDS] } }),
    closed({ kind: { enum: ['work_item_counts'] }, query: id }),
  ],
} as const

const sourceSchema = {
  anyOf: [
    closed({ note: positive }),
    closed({ evidenceId: id, locator: locatorSchema }),
    closed({ factId: id }),
    closed({ sourceId: id, locator: trackerLocatorSchema }),
  ],
} as const

const segmentSchema = closed({
  text,
  nature: { type: 'string', enum: [...NATURES] },
  sources: { type: 'array', items: sourceSchema },
})

/** The shape of what the writer answers for one slot, for the `responseSchema` of the call. */
export const slotAnswerSchema = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: [...LANGS] },
    segments: { type: 'array', items: segmentSchema },
    absences: { type: 'array', items: closed({ question: text, proposal: text }) },
    internalNotes: { type: 'array', items: segmentSchema },
  },
  required: ['lang', 'segments', 'absences', 'internalNotes'],
  additionalProperties: false,
} as const

/** The answer of the writer for one slot, read: the segments, the absences, the notes for the PM. */
export interface SlotAnswer {
  answer: ModelAnswer
  internalNotes: ModelAnswer
}

export type SlotParse = { ok: true; slot: SlotAnswer } | { ok: false; error: AnswerParseError }

const SLOT_KEYS = new Set(['lang', 'segments', 'absences', 'internalNotes'])

const fail = (path: string, problem: AnswerParseError['problem']): SlotParse => ({
  ok: false,
  error: { path, problem },
})

/** `{ note: n }` becomes the fact id of the note; any other source is left to the contract. */
function withNotes(segments: unknown): unknown {
  if (!Array.isArray(segments)) return segments
  return segments.map((s) => {
    if (typeof s !== 'object' || s === null || !Array.isArray((s as { sources?: unknown }).sources))
      return s
    const seg = s as { sources: unknown[] }
    return {
      ...seg,
      sources: seg.sources.map((src) => {
        if (typeof src !== 'object' || src === null || !('note' in src)) return src
        const { note, ...rest } = src as { note: unknown }
        if (Object.keys(rest).length > 0 || !Number.isInteger(note) || (note as number) < 1)
          return { invalid: true }
        return { factId: skeletonNoteFactId(note as number) }
      }),
    }
  })
}

const length = (s: string) => [...s].length

/**
 * Reads what the writer answered for `slot`. The shape is the contract of an answer of the model
 * (sources, texts, absences), plus the notes for the PM; the code then holds it to the slot: at
 * most `SLOT_LIMITS.segmentsMax` segments, only the natures the slot admits, no more characters
 * than it allows, no key outside the schema. Anything else is a broken form, by its path.
 */
export function parseSlotAnswer(
  raw: unknown,
  slot: { natures: readonly Nature[]; maxChars: number },
): SlotParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('', 'invalid')
  const v = raw as Record<string, unknown>
  for (const key of Object.keys(v)) if (!SLOT_KEYS.has(key)) return fail(key, 'invalid')
  if (!Array.isArray(v.internalNotes)) return fail('internalNotes', 'invalid')
  if (Array.isArray(v.segments) && v.segments.length > SLOT_LIMITS.segmentsMax) {
    return fail('segments', 'too_many')
  }
  if (v.internalNotes.length > SLOT_LIMITS.internalNotesMax) {
    return fail('internalNotes', 'too_many')
  }
  const answer = parseModelAnswer({
    lang: v.lang,
    segments: withNotes(v.segments),
    contradictions: [],
    absences: v.absences,
  })
  if ('error' in answer) return { ok: false, error: answer.error } satisfies SlotParse
  const notes = parseModelAnswer({
    lang: v.lang,
    segments: withNotes(v.internalNotes),
    contradictions: [],
    absences: [],
  })
  if ('error' in notes) {
    return {
      ok: false,
      error: { ...notes.error, path: notes.error.path.replace(/^segments/, 'internalNotes') },
    } satisfies SlotParse
  }
  for (const [i, s] of answer.segments.entries()) {
    if (!slot.natures.includes(s.nature)) return fail(`segments.${i}.nature`, 'invalid')
  }
  if (answer.segments.reduce((n, s) => n + length(s.text), 0) > slot.maxChars) {
    return fail('segments', 'too_long')
  }
  return { ok: true, slot: { answer, internalNotes: notes } } satisfies SlotParse
}

// The skeleton as the writer sees it ------------------------------------------------------------

/** What the writer was shown of a note of the skeleton: the numbers of the data that cite it. */
export interface SkeletonNoteRead {
  n: number
  ref: DocumentSourceRef
  label: string
  dataAsOf: string | null
  numbers: string[]
}

interface ShownCell {
  testo: string | null
  note: number[]
  /**
   * The suspicious-instruction patterns the detector found in the text (pattern names only):
   * a row of a system (an activity, a name, a note) shaped like an instruction stays data.
   */
  sospetto?: SuspiciousPattern[]
}

/** The patterns of the suspicious-instruction detector found in one text, each once. */
function suspiciousPatternsIn(text: string, lang: Lang): SuspiciousPattern[] {
  return [...new Set(detectSuspicious([{ text }], lang).map((h) => h.pattern))]
}

/**
 * The tables and lists of `recipe` the writer is shown only by their count: those that grow with
 * the period, one row per work item of a tracker (no `groupBy`) or per day of rows of a system
 * (`dates` within a period, as the timesheet). They are material for the PM to check, not for the
 * texts: the values the recipe computes from them stay, and the writer reads the work items with
 * the tracker tool, whose answers are cited and verified like any other source. The counts by a
 * field and the rows of a system without a period (the invoices of an order) stay as rows.
 */
export function writerCountedBlocks(recipe: Recipe): Set<string> {
  const grows = (q: RecipeQuery) =>
    (q.kind === 'tracker' && q.groupBy === undefined) ||
    (q.kind === 'system_rows' && q.dates !== undefined)
  return new Set(
    recipe.sections.flatMap((s) =>
      s.blocks.flatMap((b) =>
        (b.kind === 'data_table' || b.kind === 'data_list') && grows(b.query) ? [b.id] : [],
      ),
    ),
  )
}

/** What the writer of a slot that reaches the client must not see. */
export interface WriterHiding {
  /** A place the writer must not see. */
  ref(ref: DocumentSourceRef): boolean
  /**
   * Every place each computed value reads, by block id (beyond the notes its cell cites);
   * `complete` false when a place it reads is not known, which hides the value, as the gate
   * judges such a value internal.
   */
  valueReads?: ReadonlyMap<string, { refs: readonly DocumentSourceRef[]; complete: boolean }>
}

/**
 * The skeleton as the writer reads it, and what it was shown of each note: the data of the
 * tables (the first `SLOT_LIMITS.rowsShown` rows of each; only the count of the blocks in
 * `counted`), the values and the fixed texts, the slots to write, and the notes the shown cells
 * and values cite, with their titles and dates. The numbers of a note are those of the shown cells
 * and values that cite it: a number the writer cites from a note must be one of them.
 * Every shown cell, text block and note title passes the suspicious-instruction detector, as the
 * texts of the evidence do: one shaped like an instruction is marked `sospetto` with the pattern
 * names, never changed.
 *
 * `hiding`: places the writer must not see (the work items of an internal tracker, for a slot that
 * reaches the client): a row citing one is left out, a value reading one (any place it reads, not
 * only the notes its cell cites) is shown without its text, a text written from one is shown
 * without its segments, and their notes are not listed.
 */
export function skeletonForWriter(
  skeleton: DocumentSkeleton,
  lang: Lang,
  hiding?: WriterHiding,
  counted: ReadonlySet<string> = new Set(),
): { context: unknown; reads: SkeletonNoteRead[] } {
  const numbers = new Map<number, Set<string>>()
  const hidden = hiding?.ref
  const hiddenNotes = new Set(
    hidden === undefined
      ? []
      : skeleton.sourceNotes.flatMap((n) => ('ref' in n && hidden(n.ref) ? [n.n] : [])),
  )
  const isHidden = (cell: DocumentCell) => cell.sources.some((n) => hiddenNotes.has(n))
  /** A value hidden by the notes of its cell, by any place it reads, or by a place not known. */
  const isHiddenValue = (id: string, cell: DocumentCell) => {
    if (isHidden(cell)) return true
    if (hidden === undefined) return false
    const read = hiding?.valueReads?.get(id)
    if (read === undefined) return false
    return !read.complete || read.refs.some((ref) => hidden(ref))
  }
  /** `sospetto` with the pattern names when the detector finds an instruction in the text. */
  const marked = (text: string | null): { sospetto?: SuspiciousPattern[] } => {
    const found = text === null ? [] : suspiciousPatternsIn(text, lang)
    return found.length > 0 ? { sospetto: found } : {}
  }
  const shown = (cell: DocumentCell): ShownCell => {
    for (const n of cell.sources) {
      let set = numbers.get(n)
      if (!set) {
        set = new Set()
        numbers.set(n, set)
      }
      for (const x of numbersIn(cell.text ?? '', lang)) set.add(x)
    }
    return { testo: cell.text, note: [...cell.sources], ...marked(cell.text) }
  }
  const sections = skeleton.sections.map((s) => ({
    id: s.id,
    titolo: s.title,
    non_dedotta: s.notDeduced,
    blocchi: s.blocks.map((b) => {
      switch (b.kind) {
        case 'slot':
          return { id: b.id, tipo: 'testo_da_scrivere', titolo: b.title ?? null }
        case 'static':
          return { id: b.id, tipo: 'testo_fisso', testo: b.text }
        case 'value':
          return {
            id: b.id,
            tipo: 'valore',
            etichetta: b.label,
            valore: isHiddenValue(b.id, b.cell) ? { testo: null, note: [] } : shown(b.cell),
          }
        case 'text': {
          // A text written from a hidden place (in a revision, another slot) is not shown.
          if (b.segments.some((x) => x.sources.some((n) => hiddenNotes.has(n)))) {
            return { id: b.id, tipo: 'testo', segmenti: [] }
          }
          const suspicious = marked(b.segments.map((x) => x.text).join('\n'))
          return { id: b.id, tipo: 'testo', segmenti: b.segments.map((x) => x.text), ...suspicious }
        }
        default: {
          const rows = (b.kind === 'table' ? b.rows : b.items).filter(
            (r) => !r.cells.some(isHidden),
          )
          if (counted.has(b.id)) {
            return {
              id: b.id,
              tipo: b.kind === 'table' ? 'tabella' : 'elenco',
              titolo: b.title ?? null,
              non_dedotto: b.notDeduced,
              colonne: b.columns.map((c) => c.title),
              solo_conteggio: true,
              righe: [],
              righe_non_mostrate: rows.length,
            }
          }
          return {
            id: b.id,
            tipo: b.kind === 'table' ? 'tabella' : 'elenco',
            titolo: b.title ?? null,
            non_dedotto: b.notDeduced,
            colonne: b.columns.map((c) => c.title),
            righe: rows.slice(0, SLOT_LIMITS.rowsShown).map((r) => r.cells.map(shown)),
            righe_non_mostrate: Math.max(0, rows.length - SLOT_LIMITS.rowsShown),
          }
        }
      }
    }),
  }))
  const reads = skeleton.sourceNotes.flatMap((note): SkeletonNoteRead[] =>
    'ref' in note
      ? [
          {
            n: note.n,
            ref: note.ref,
            label: note.label,
            dataAsOf: note.dataAsOf,
            numbers: [...(numbers.get(note.n) ?? [])],
          },
        ]
      : [],
  )
  // Only the notes the shown rows and values cite: never one note per work item of a tracker.
  const notes = skeleton.sourceNotes.filter((n) => !hiddenNotes.has(n.n) && numbers.has(n.n))
  return {
    context: {
      titolo: skeleton.title,
      sezioni: sections,
      note: notes.map((n) => ({
        n: n.n,
        fonte: n.label,
        dati_al: n.dataAsOf,
        ...marked(n.label),
      })),
      // Only the notes the writer may see: the hidden ones are not even counted.
      note_non_mostrate:
        skeleton.sourceNotes.filter((n) => !hiddenNotes.has(n.n)).length - notes.length,
    },
    reads,
  }
}

// From the verifier to the draft ----------------------------------------------------------------

/** The place a citation of the model stands for in the draft; null when it cannot stand for one. */
export function documentRefOf(
  ref: AnswerSourceRef,
  skeletonNotes: ReadonlyMap<number, DocumentSourceRef>,
): DocumentSourceRef | null {
  if ('factId' in ref) {
    const n = skeletonNoteOf(ref.factId)
    if (n !== null) return skeletonNotes.get(n) ?? null
    return { kind: 'fact', factId: ref.factId }
  }
  if ('sourceId' in ref) {
    const l = ref.locator
    if (l.kind === 'work_item_counts') {
      if (l.query === undefined) return null
      return { kind: 'work_item_counts', sourceId: ref.sourceId, query: l.query }
    }
    return {
      kind: 'work_item',
      sourceId: ref.sourceId,
      id: l.id,
      ...(l.field === undefined ? {} : { field: l.field }),
    }
  }
  return { kind: 'evidence', evidenceId: ref.evidenceId, locator: ref.locator }
}

export interface SlotSourceContext {
  /** The notes of the skeleton, by number. */
  skeletonNotes: readonly SkeletonNoteRead[]
  /** What the client gate knows of the evidence and facts that may be cited. */
  audience: Pick<AudienceContext, 'evidence' | 'facts'>
}

/** What a source may hold, recomputed from its place; null when the gates do not know it. */
function categoryOf(ref: DocumentSourceRef, ctx: SlotSourceContext): DataCategory | null {
  try {
    return mostRestrictiveOf(sourceRefCategories(ref, ctx.audience))
  } catch (e) {
    if (e instanceof DomainError) return null
    throw e
  }
}

function slotSegments(segments: readonly VerifiedSegment[], ctx: SlotSourceContext): SlotSegment[] {
  const notes = new Map(ctx.skeletonNotes.map((n) => [n.n, n]))
  const refs = new Map(ctx.skeletonNotes.map((n) => [n.n, n.ref]))
  return segments.map((s) => ({
    text: s.originalText,
    nature: s.nature as Nature,
    category: 'other',
    sources: s.sources.flatMap((v): SlotSource[] => {
      if (!v.verified) return []
      const ref = documentRefOf(v.ref, refs)
      if (ref === null) return []
      const n = 'factId' in v.ref ? skeletonNoteOf(v.ref.factId) : null
      const note = n === null ? undefined : notes.get(n)
      // A source the gates know nothing of stands for nothing in the draft (fail closed).
      const category = categoryOf(ref, ctx)
      if (category === null) return []
      return [
        {
          ref,
          label: note?.label ?? v.title ?? '',
          dataAsOf: note ? note.dataAsOf : (v.sourceDate?.toISOString() ?? null),
          // What the source may hold, recomputed from its place, never declared by the model.
          category,
        },
      ]
    }),
  }))
}

/**
 * The content of a slot from what the verifier checked: every segment with its text as the model
 * wrote it (the red-team keeps the findings of the verifier on it), and only its verified sources.
 */
export function slotContentOf(
  verified: VerifiedAnswer,
  internalNotes: VerifiedAnswer,
  ctx: SlotSourceContext,
): SlotContent {
  return {
    segments: slotSegments(verified.segments, ctx),
    internalNotes: slotSegments(internalNotes.segments, ctx),
  }
}

// Revisions ---------------------------------------------------------------------------------------

/**
 * The text slots a request of the PM rewrites: only text blocks of the draft that are slots of
 * the recipe. A request on a table, a value, a fixed text, a title or a section touches the
 * skeleton: it is `pm_request_touches_skeleton`, and the PM is sent to «Salva come regola della
 * ricetta».
 */
export function pmRequestSlots(
  doc: DeliverableDocument,
  recipe: Recipe,
  targets: readonly string[],
): string[] {
  const slots = new Set<string>()
  for (const s of recipe.sections) {
    for (const b of s.blocks) if (b.kind === 'text_slot') slots.add(b.id)
  }
  const texts = new Set<string>()
  for (const s of doc.sections) for (const b of s.blocks) if (b.kind === 'text') texts.add(b.id)
  if (targets.length === 0 || targets.some((t) => !slots.has(t) || !texts.has(t))) {
    throw new DomainError('pm_request_touches_skeleton')
  }
  return [...new Set(targets)].sort()
}

/**
 * The skeleton of a new revision: the previous draft as it is, with the text blocks of `slots`
 * open again as slots of the recipe. Everything else (tables, values, the other texts, the source
 * notes and the header) stays as it was, so only those slots can change.
 */
export function skeletonOfRevision(
  doc: DeliverableDocument,
  recipe: Recipe,
  slots: readonly string[],
): DocumentSkeleton {
  if (doc.audience !== 'internal') throw new DomainError('skeleton_malformed')
  const open = new Set(slots)
  const declared = new Map(
    recipe.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.kind === 'text_slot' ? [[b.id, b] as const] : [])),
    ),
  )
  return {
    schema: doc.schema,
    recipe: { ...doc.recipe },
    audience: 'internal',
    lang: doc.lang,
    title: doc.title,
    header: { ...doc.header },
    sourceNotes: doc.sourceNotes.map((n) => structuredClone(n)),
    sections: doc.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map((b) => {
        const slot = b.kind === 'text' && open.has(b.id) ? declared.get(b.id) : undefined
        if (slot === undefined) return structuredClone(b)
        return {
          kind: 'slot' as const,
          id: slot.id,
          ...(slot.title === undefined ? {} : { title: slot.title }),
          natures: [...slot.natures],
          maxChars: slot.maxChars,
        }
      }),
    })),
  }
}
