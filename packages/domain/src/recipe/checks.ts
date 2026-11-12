import { z } from 'zod'
import { pairCheckSchemas } from './pair-checks.ts'

// The closed catalog of the checks a recipe can ask for. The code runs them on the skeleton, and
// each has a fixed class: a recipe names a check and its targets, never its class. On a text the
// code checks only its form: the length, forbidden phrases, the kinds of place each segment cites,
// the fields a segment states. Semantic checks on the text («no "no blockers" while blockers are
// open», an owner the cited line really declares) are rules of the model reviewer, always of
// class `data`.

/** The class of a gate or a check: what may be fixed automatically depends on it. */
export const CHECK_CLASSES = ['data', 'form', 'structure'] as const
export type CheckClass = (typeof CHECK_CLASSES)[number]

export const CHECK_KINDS = [
  'sum_equals',
  'sum_at_most',
  'difference_equals',
  'values_equal',
  'present',
  'member_of',
  'count_consistent',
  'date_within_period',
  'unique',
  'coverage',
  'implies',
  'equals_previous',
  'bounded_text',
  'agree_by_key',
  'all_equal_when',
  'sum_by_key',
  'segments_cited',
  'segment_fields',
] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

/** The class of every check of the catalog: only the bounded free text is a matter of form. */
export const CHECK_CLASS: Readonly<Record<CheckKind, CheckClass>> = Object.freeze({
  sum_equals: 'data',
  sum_at_most: 'data',
  difference_equals: 'data',
  values_equal: 'data',
  present: 'data',
  member_of: 'data',
  count_consistent: 'data',
  date_within_period: 'data',
  unique: 'data',
  coverage: 'data',
  implies: 'data',
  equals_previous: 'data',
  bounded_text: 'form',
  agree_by_key: 'data',
  all_equal_when: 'data',
  sum_by_key: 'data',
  segments_cited: 'data',
  segment_fields: 'data',
})

export function checkClassOf(kind: CheckKind): CheckClass {
  return CHECK_CLASS[kind]
}

/** Identifier of a section, a block, a column, a parameter or a check. */
export const RECIPE_ID = /^[a-z][a-z0-9_]{0,39}$/
export const recipeId = z.string().regex(RECIPE_ID)

/** A short text for the PM: a label, a title. */
export const MAX_LABEL_LENGTH = 120
/** A longer text for the PM or the model: a message, an instruction, a rule. */
export const MAX_TEXT_LENGTH = 1_000
/** Longest bounded text a check may ask for, and longest text slot. */
export const MAX_SLOT_CHARS = 8_000
/** Phrases a bounded-text check may forbid. */
export const MAX_FORBIDDEN_PHRASES = 30
/** Values listed in an implication. */
export const MAX_LISTED_VALUES = 30
/** Fields a segment check may ask for. */
export const MAX_SEGMENT_FIELDS = 5

/** The kinds of place a segment of a text can cite, as the document names them. */
export const SEGMENT_SOURCE_KINDS = [
  'evidence',
  'work_item',
  'work_item_counts',
  'system_row',
  'fact',
  'parameter',
] as const
export type SegmentSourceKind = (typeof SEGMENT_SOURCE_KINDS)[number]

const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH)
const pmText = z.string().trim().min(1).max(MAX_TEXT_LENGTH)

/** A column of a table or a list block. */
export const columnRefSchema = z.strictObject({ block: recipeId, column: recipeId })
export type ColumnRef = z.infer<typeof columnRefSchema>

/** A single value: a computed value block, or a parameter of the PM. */
export const valueRefSchema = z.union([
  z.strictObject({ value: recipeId }),
  z.strictObject({ parameter: recipeId }),
])
export type ValueRef = z.infer<typeof valueRefSchema>

/** A computed value, or a column of a table or a list block. */
export const targetRefSchema = z.strictObject({ block: recipeId, column: recipeId.optional() })
export type TargetRef = z.infer<typeof targetRefSchema>

const valueList = z
  .array(z.string().trim().min(1).max(MAX_LABEL_LENGTH))
  .min(1)
  .max(MAX_LISTED_VALUES)

const base = {
  id: recipeId,
  /** The name of the check for the PM («somma delle posizioni»). */
  label,
  /** What the PM reads when the check fails. */
  message: pmText,
}

export const checkSchema = z.discriminatedUnion('kind', [
  /** The sum of a column equals a value. */
  z.strictObject({
    ...base,
    kind: z.literal('sum_equals'),
    column: columnRefSchema,
    equals: valueRefSchema,
  }),
  /** The sum of a column does not exceed a value. */
  z.strictObject({
    ...base,
    kind: z.literal('sum_at_most'),
    column: columnRefSchema,
    atMost: valueRefSchema,
    /**
     * The sum also counts the values of the column declared to the client before (the requests
     * already issued, in any period), each row as approved last, but never the rows of this run.
     */
    withDeclared: z.boolean().optional(),
  }),
  /** On every row: `result` = `minuend` − `subtrahend`, three columns of one block. */
  z.strictObject({
    ...base,
    kind: z.literal('difference_equals'),
    block: recipeId,
    result: recipeId,
    minuend: recipeId,
    subtrahend: recipeId,
  }),
  /** Two values are equal. */
  z.strictObject({
    ...base,
    kind: z.literal('values_equal'),
    left: valueRefSchema,
    right: valueRefSchema,
  }),
  /** A block has data: at least one row, or a value. */
  z.strictObject({ ...base, kind: z.literal('present'), block: recipeId }),
  /** Every value of a column is among the values of another column. */
  z.strictObject({
    ...base,
    kind: z.literal('member_of'),
    column: columnRefSchema,
    in: columnRefSchema,
  }),
  /** The rows of a block are as many as a value says. */
  z.strictObject({
    ...base,
    kind: z.literal('count_consistent'),
    block: recipeId,
    count: valueRefSchema,
  }),
  /** Every date of a column falls within a period parameter. */
  z.strictObject({
    ...base,
    kind: z.literal('date_within_period'),
    column: columnRefSchema,
    period: recipeId,
  }),
  /**
   * No value of a column twice (no double counting); `againstDeclared`: nor one already declared
   * to the client (a request number already issued).
   */
  z.strictObject({
    ...base,
    kind: z.literal('unique'),
    column: columnRefSchema,
    againstDeclared: z.boolean(),
  }),
  /**
   * Every value of `universe` is in one of the `coveredBy` columns: attributed, excluded or, when
   * `allowUnassigned`, left «da attribuire» to the PM. `exclusive`: a partition, every value in
   * exactly one of them.
   */
  z.strictObject({
    ...base,
    kind: z.literal('coverage'),
    universe: columnRefSchema,
    coveredBy: z.array(columnRefSchema).min(1).max(10),
    allowUnassigned: z.boolean(),
    exclusive: z.boolean(),
  }),
  /** On every row of a block: when a column holds one of some values, another holds one of others. */
  z.strictObject({
    ...base,
    kind: z.literal('implies'),
    block: recipeId,
    condition: z.strictObject({ column: recipeId, in: valueList }),
    consequence: z.strictObject({ column: recipeId, in: valueList }),
  }),
  /** A value equals the one declared to the client for `previous` in the last approved version. */
  z.strictObject({
    ...base,
    kind: z.literal('equals_previous'),
    current: targetRefSchema,
    previous: targetRefSchema,
  }),
  /** A text slot within a length, without forbidden phrases, with link phrases free of data. */
  z.strictObject({
    ...base,
    kind: z.literal('bounded_text'),
    slot: recipeId,
    maxChars: z.int().min(1).max(MAX_SLOT_CHARS).optional(),
    forbiddenPhrases: z
      .array(z.string().trim().min(1).max(MAX_LABEL_LENGTH))
      .max(MAX_FORBIDDEN_PHRASES),
    connectorsWithoutData: z.boolean(),
  }),
  ...pairCheckSchemas({
    base,
    id: recipeId,
    columnRef: columnRefSchema,
    valueRef: valueRefSchema,
  }),
  /** Every segment of a text slot cites a place of one of these kinds (a decision, a result). */
  z.strictObject({
    ...base,
    kind: z.literal('segments_cited'),
    slot: recipeId,
    sourceKinds: z.array(z.enum(SEGMENT_SOURCE_KINDS)).min(1).max(SEGMENT_SOURCE_KINDS.length),
    /**
     * A selection of evidence of the PM (the transcript): a piece of evidence counts only when it
     * is one the selection holds, as the block listing the selection shows it.
     */
    parameter: recipeId.optional(),
  }),
  /**
   * Every segment of a text slot states each field («Responsabile: …»): either its placeholder
   * («da assegnare») or a value, and a value only in a segment that cites a place of one of
   * `sourceKinds` (an owner the transcript declares).
   */
  z.strictObject({
    ...base,
    kind: z.literal('segment_fields'),
    slot: recipeId,
    fields: z
      .array(z.strictObject({ label, placeholder: label }))
      .min(1)
      .max(MAX_SEGMENT_FIELDS),
    sourceKinds: z.array(z.enum(SEGMENT_SOURCE_KINDS)).min(1).max(SEGMENT_SOURCE_KINDS.length),
    /** As for `segments_cited`: the selection of evidence a value must cite. */
    parameter: recipeId.optional(),
  }),
])
export type RecipeCheck = z.infer<typeof checkSchema>
