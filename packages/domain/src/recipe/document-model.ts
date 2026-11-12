import { z } from 'zod'
import { NATURES } from '../answer.ts'
import { WORK_ITEM_FIELDS } from '../tracker.ts'
import { DATA_CATEGORIES } from './categories.ts'
import { MAX_SLOT_CHARS } from './checks.ts'
import { SECTION_VERSIONS } from './format.ts'

// The document model of a deliverable, `octobrief.document/1`: what the worker builds, the PM
// approves and the renderer turns into a file. One contract for all three, exported as JSON
// Schema for the renderer and the shared fixtures. It is not what the model answers: the output
// of the model has its own portable schema, and only its verified slots enter a document.

export const DOCUMENT_SCHEMA = 'octobrief.document/1' as const

const MAX_TEXT = 20_000
const MAX_TITLE = 300

const text = z.string().max(MAX_TEXT)
const title = z.string().min(1).max(MAX_TITLE)
const id = z.string().min(1).max(100)
const category = z.enum(DATA_CATEGORIES)
const instant = z.iso.datetime()
const noteNumber = z.int().min(1)

const locatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), page: z.int().min(1) }),
  z.strictObject({ kind: z.literal('paragraph'), index: z.int().min(1) }),
  z.strictObject({ kind: z.literal('slide'), slide: z.int().min(1) }),
  z.strictObject({ kind: z.literal('cell'), sheet: z.string().min(1), ref: z.string().min(1) }),
  z.strictObject({ kind: z.literal('line'), from: z.int().min(1), to: z.int().min(1) }),
])

/** Where a datum of the document comes from, as the code verified it. */
export const documentSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('evidence'), evidenceId: id, locator: locatorSchema }),
  z.strictObject({
    kind: z.literal('work_item'),
    sourceId: id,
    id: z.string().min(1).max(512),
    field: z.enum(WORK_ITEM_FIELDS).optional(),
  }),
  z.strictObject({ kind: z.literal('work_item_counts'), sourceId: id, query: id }),
  z.strictObject({
    kind: z.literal('system_row'),
    sourceId: id,
    view: id,
    /** The columns that identify the row, in the order of the view's key. */
    key: z
      .array(z.strictObject({ column: id, value: z.string().max(1_000) }))
      .min(1)
      .max(10),
    /**
     * The columns of the row the citation stands for, set by the code from what the skeleton
     * read; without them the row is worth every column of its view.
     */
    columns: z.array(id).min(1).max(50).optional(),
  }),
  z.strictObject({ kind: z.literal('fact'), factId: id }),
  /** A value typed by the PM: «indicato da te». */
  z.strictObject({
    kind: z.literal('parameter'),
    parameterId: id,
    /** The documents the PM copied the value from, when the recipe asks for them. */
    evidenceIds: z.array(id).min(1).max(200).optional(),
  }),
])
export type DocumentSourceRef = z.infer<typeof documentSourceRefSchema>

/** A numbered source note of the internal version: a title, and the place it cites. */
export const internalSourceNoteSchema = z.strictObject({
  n: noteNumber,
  label: title,
  /** When the data was current at the source; null when the source does not say. */
  dataAsOf: instant.nullable(),
  ref: documentSourceRefSchema,
})

/**
 * A numbered source note of the client version: a generic class of source and its date
 * («Sistema amministrativo, dati al …»), never the title of a piece of evidence nor a place.
 */
export const clientSourceNoteSchema = z.strictObject({
  n: noteNumber,
  label: title,
  dataAsOf: instant.nullable(),
})

export type SourceNote =
  | z.infer<typeof internalSourceNoteSchema>
  | z.infer<typeof clientSourceNoteSchema>

export const segmentSchema = z
  .strictObject({
    text,
    nature: z.enum(NATURES),
    /**
     * For display only: the declared category raised to what the cited sources hold. The client
     * gate admits a segment by `sourceCategories`, entry by entry.
     */
    category,
    /** Numbers of the source notes. */
    sources: z.array(noteNumber).max(20),
    /** The category of what each cited source holds, one per entry of `sources`, in its order. */
    sourceCategories: z.array(category).max(20),
  })
  // The JSON Schema cannot say «as many as»: the renderer and the gate check it again.
  .superRefine((s, ctx) => {
    if (s.sourceCategories.length !== s.sources.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceCategories'],
        message: 'one category per cited source',
      })
    }
  })
export type DocumentSegment = z.infer<typeof segmentSchema>

/** A cell or a value; `text` null is «non dedotto». */
export const cellSchema = z.strictObject({
  text: z.string().max(2_000).nullable(),
  /** For display only: the client gate admits a cell by `operandCategories`, entry by entry. */
  category,
  /**
   * The effective categories the cell is made of: the one of its column for a plain cell, one
   * per operand for a computed cell or value.
   */
  operandCategories: z.array(category).min(1).max(10),
  sources: z.array(noteNumber).max(20),
})
export type DocumentCell = z.infer<typeof cellSchema>

export const columnSchema = z.strictObject({ id, title, category })

/** A row; `key` identifies it, so the decisions of the PM follow it wherever it moves. */
export const rowSchema = z.strictObject({
  key: z.string().min(1).max(1_000),
  cells: z.array(cellSchema),
})
export type DocumentRow = z.infer<typeof rowSchema>

const rowsBlock = {
  id,
  title: title.optional(),
  columns: z.array(columnSchema).min(1),
  /** No data could be deduced for the block. */
  notDeduced: z.boolean(),
}

export const documentBlockSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    id,
    title: title.optional(),
    segments: z.array(segmentSchema),
    notDeduced: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('list'), ...rowsBlock, items: z.array(rowSchema) }),
  z.strictObject({ kind: z.literal('table'), ...rowsBlock, rows: z.array(rowSchema) }),
  z.strictObject({ kind: z.literal('value'), id, label: title, cell: cellSchema }),
  /** A fixed text of the recipe, without data. */
  z.strictObject({ kind: z.literal('static'), id, text }),
])
export type DocumentBlock = z.infer<typeof documentBlockSchema>

export const documentSectionSchema = z.strictObject({
  id,
  title,
  version: z.enum(SECTION_VERSIONS),
  /** A mandatory parameter of the section was skipped: shown as «non dedotto». */
  notDeduced: z.boolean(),
  blocks: z.array(documentBlockSchema),
})
export type DocumentSection = z.infer<typeof documentSectionSchema>

const recipeRef = z.strictObject({
  slug: z.string().min(1).max(60),
  version: z.string().min(1).max(30),
  title,
})

/** «Dati al …, generato il …»: the age of the data in the file; the live age is only in the UI. */
const headerSchema = z.strictObject({ dataAsOf: instant.nullable(), generatedAt: instant })

const documentBase = {
  schema: z.literal(DOCUMENT_SCHEMA),
  recipe: recipeRef,
  lang: z.enum(['it']),
  title,
  header: headerSchema,
}

/**
 * The document, one shape per version: the internal one cites places and carries the notes for
 * the PM; the client one has generic source notes without places and no internal notes at all.
 */
export const documentSchema = z.discriminatedUnion('audience', [
  z.strictObject({
    ...documentBase,
    audience: z.literal('internal'),
    sections: z.array(documentSectionSchema),
    sourceNotes: z.array(internalSourceNoteSchema),
    /** Notes for the PM. */
    internalNotes: z.array(segmentSchema),
  }),
  z.strictObject({
    ...documentBase,
    audience: z.literal('client'),
    sections: z.array(documentSectionSchema),
    sourceNotes: z.array(clientSourceNoteSchema),
    /** Never any in a file for the client. */
    internalNotes: z.array(segmentSchema).max(0),
  }),
])
export type DeliverableDocument = z.infer<typeof documentSchema>

/** The JSON Schema of the document, for the renderer and the shared fixtures. */
export const DOCUMENT_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze(
  z.toJSONSchema(documentSchema, { target: 'draft-2020-12' }) as Record<string, unknown>,
)

// The skeleton: the document as the code computes it, with the text slots still to write.

export const skeletonSlotSchema = z.strictObject({
  kind: z.literal('slot'),
  id,
  title: title.optional(),
  natures: z.array(z.enum(NATURES)).min(1),
  maxChars: z.int().min(1).max(MAX_SLOT_CHARS),
})
export type SkeletonSlot = z.infer<typeof skeletonSlotSchema>

export const skeletonSectionSchema = z.strictObject({
  ...documentSectionSchema.shape,
  blocks: z.array(z.union([documentBlockSchema, skeletonSlotSchema])),
})
export type SkeletonSection = z.infer<typeof skeletonSectionSchema>

export const skeletonSchema = z.discriminatedUnion('audience', [
  z.strictObject({
    ...documentBase,
    audience: z.literal('internal'),
    sections: z.array(skeletonSectionSchema),
    sourceNotes: z.array(internalSourceNoteSchema),
  }),
  z.strictObject({
    ...documentBase,
    audience: z.literal('client'),
    sections: z.array(skeletonSectionSchema),
    sourceNotes: z.array(clientSourceNoteSchema),
  }),
])
export type DocumentSkeleton = z.infer<typeof skeletonSchema>
