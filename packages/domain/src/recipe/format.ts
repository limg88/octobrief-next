import { z } from 'zod'
import { NATURES } from '../answer.ts'
import { DOCUMENT_KINDS } from '../classification.ts'
import { FACT_KINDS } from '../knowledge.ts'
import { TRACKER_DATE_FIELDS, TRACKER_GROUP_FIELDS } from '../tracker.ts'
import { DATA_CATEGORIES } from './categories.ts'
import {
  checkSchema,
  columnRefSchema,
  MAX_LABEL_LENGTH,
  MAX_SLOT_CHARS,
  MAX_TEXT_LENGTH,
  recipeId,
  valueRefSchema,
} from './checks.ts'
import { MAX_TYPED_ROWS, rowsColumnsSchema } from './rows-parameter.ts'
import { SOURCE_KINDS } from './source-kinds.ts'

// The format of a recipe, `octobrief.recipe/1`: one typed document per version, kept in the
// database and never shown to the PM as such. Queries are declarative and closed (no free SQL,
// no free filter): the code runs them, the model only writes inside the declared text slots.

export const RECIPE_SCHEMA = 'octobrief.recipe/1'

export const RECIPE_AUDIENCES = ['internal', 'client', 'both'] as const
export type RecipeAudience = (typeof RECIPE_AUDIENCES)[number]

/** Which version of the deliverable a section belongs to. */
export const SECTION_VERSIONS = ['internal', 'client', 'both'] as const
export type SectionVersion = (typeof SECTION_VERSIONS)[number]

export const PREREQUISITE_LEVELS = ['required', 'if_present'] as const
export type PrerequisiteLevel = (typeof PREREQUISITE_LEVELS)[number]

export const RENDER_FORMATS = ['md', 'docx', 'pptx', 'xlsx'] as const
export type RenderFormat = (typeof RENDER_FORMATS)[number]

export const PARAMETER_TYPES = [
  'text',
  'date',
  'period',
  'choice',
  'number',
  'evidence_selection',
  'work_item_selection',
  'rows',
] as const
export type ParameterType = (typeof PARAMETER_TYPES)[number]

/**
 * A parameter in a title, written `{{id}}` (spaces inside the braces allowed). The one pattern
 * for validation, differences and the titles of the documents.
 */
export const TITLE_PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g

/**
 * The parameters a title may show: a period, a choice, a number. Never a free text, which could
 * carry anything into a title the client reads.
 */
export const TITLE_PARAMETER_TYPES: readonly ParameterType[] = ['period', 'choice', 'number']

/** Parameters asked to the PM in one step, at most: the same bound as every question. */
export const MAX_PARAMETERS_PER_STEP = 5
export const MAX_PARAMETERS = 30
export const MAX_STEPS = 10
export const MAX_SECTIONS = 30
export const MAX_BLOCKS_PER_SECTION = 20
export const MAX_COLUMNS = 20
export const MAX_CHECKS = 50
export const MAX_RULES = 30
export const MAX_EXAMPLES = 5
export const MAX_PREREQUISITES = 20

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const SLUG = /^[a-z][a-z0-9-]{0,59}$/
/** A name of a cell of a workbook, as the template declares it. */
const CELL_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/

const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH)
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH)
const category = z.enum(DATA_CATEGORIES)
const paramRef = z.strictObject({ parameter: recipeId })

// Parameters -------------------------------------------------------------------------------------

const parameterBase = {
  id: recipeId,
  label,
  help: text.optional(),
  required: z.boolean(),
  /** The step the parameter is asked in: at most five per step. */
  step: z.int().min(1).max(MAX_STEPS),
}

export const parameterSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...parameterBase,
    type: z.literal('text'),
    maxLength: z.int().min(1).max(MAX_TEXT_LENGTH),
  }),
  z.strictObject({ ...parameterBase, type: z.literal('date') }),
  z.strictObject({ ...parameterBase, type: z.literal('period') }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('choice'),
    options: z
      .array(z.strictObject({ value: recipeId, label }))
      .min(1)
      .max(30),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('number'),
    integer: z.boolean(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('evidence_selection'),
    documentKinds: z.array(z.enum(DOCUMENT_KINDS)).max(DOCUMENT_KINDS.length).optional(),
    multiple: z.boolean(),
  }),
  z.strictObject({
    ...parameterBase,
    type: z.literal('work_item_selection'),
    multiple: z.boolean(),
  }),
  /** A table the PM types, copied from the document selected with it: never by the model. */
  z.strictObject({
    ...parameterBase,
    type: z.literal('rows'),
    columns: rowsColumnsSchema({ id: recipeId, label, maxText: MAX_TEXT_LENGTH }),
    maxRows: z.int().min(1).max(MAX_TYPED_ROWS),
    /**
     * The evidence parameter whose documents the rows are copied from: the rows cite them, and
     * the PM who gives the rows gives the documents too. Absent for a table of decisions of the
     * PM (attributions), which copies no document.
     */
    evidence: recipeId.optional(),
    /** The columns that tell the rows apart: two rows with the same values are refused. */
    key: z.array(recipeId).min(1).max(5).optional(),
  }),
])
export type RecipeParameter = z.infer<typeof parameterSchema>

/**
 * What a value of a parameter cites in the deliverable: a selection of evidence or work items
 * cites what was selected; anything typed by the PM is «indicato da te».
 */
export function parameterCitation(type: ParameterType): 'evidence' | 'work_item' | 'pm' {
  if (type === 'evidence_selection') return 'evidence'
  if (type === 'work_item_selection') return 'work_item'
  return 'pm'
}

// Prerequisites ----------------------------------------------------------------------------------

export const freshnessSchema = z.strictObject({
  warnAfterHours: z.int(),
  stopAfterHours: z.int(),
})

export const prerequisiteSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('evidence'),
    documentKinds: z.array(z.enum(DOCUMENT_KINDS)).min(1).max(DOCUMENT_KINDS.length),
    level: z.enum(PREREQUISITE_LEVELS),
  }),
  z.strictObject({
    kind: z.literal('source'),
    sourceKinds: z.array(z.enum(SOURCE_KINDS)).min(1).max(SOURCE_KINDS.length),
    level: z.enum(PREREQUISITE_LEVELS),
    /** Only stricter than the defaults, and only for system data. */
    freshness: freshnessSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('fact'),
    factKind: z.enum(FACT_KINDS),
    key: z.string().trim().min(1).max(200).optional(),
    level: z.enum(PREREQUISITE_LEVELS),
  }),
])
export type RecipePrerequisite = z.infer<typeof prerequisiteSchema>

// Queries ----------------------------------------------------------------------------------------

/** A literal value of a filter, or the value of a parameter. */
const filterValue = z.union([z.string().trim().min(1).max(MAX_LABEL_LENGTH), paramRef])
const filterList = z.array(filterValue).min(1).max(30)
const calendarDay = z.iso.date()

export const trackerQuerySchema = z.strictObject({
  kind: z.literal('tracker'),
  filter: z.strictObject({
    types: filterList.optional(),
    /** Types never counted, whatever the other filters say (the tasks of a sprint). */
    excludedTypes: filterList.optional(),
    states: filterList.optional(),
    sprints: filterList.optional(),
    iterations: filterList.optional(),
    areas: filterList.optional(),
    assignees: filterList.optional(),
    dates: z
      .strictObject({
        field: z.enum(TRACKER_DATE_FIELDS),
        from: z.union([calendarDay, paramRef]).optional(),
        to: z.union([calendarDay, paramRef]).optional(),
        /** A period parameter: both ends at once. */
        period: paramRef.optional(),
      })
      .optional(),
    /** Only the work items the tracker gives without this date («non dedotto»). */
    undated: z.enum(TRACKER_DATE_FIELDS).optional(),
  }),
  /** Counts by this field instead of the work items themselves. */
  groupBy: z.enum(TRACKER_GROUP_FIELDS).optional(),
  /**
   * The decisions of the PM on the work items read, applied by the code before any count: the
   * work items left out, and the parent each listed work item is attributed to.
   */
  decisions: z
    .strictObject({
      excluded: paramRef.optional(),
      attributions: z
        .strictObject({
          parameter: recipeId,
          item: recipeId,
          parent: recipeId,
          /** A column naming the tracker of the item, when two trackers may share an id. */
          source: recipeId.optional(),
        })
        .optional(),
    })
    .optional(),
})

export const systemRowsQuerySchema = z.strictObject({
  kind: z.literal('system_rows'),
  view: z.string().min(1).max(100),
  where: z
    .array(
      z.strictObject({
        column: z.string().min(1).max(100),
        equals: z.union([z.string().trim().min(1).max(MAX_LABEL_LENGTH), z.number(), paramRef]),
      }),
    )
    .max(10)
    .optional(),
  /** Only the rows whose date column falls within a period parameter of the run. */
  dates: z.strictObject({ column: z.string().min(1).max(100), period: paramRef }).optional(),
})

export const factsQuerySchema = z.strictObject({
  kind: z.literal('facts'),
  factKind: z.enum(FACT_KINDS),
  key: z.string().trim().min(1).max(200).optional(),
  /**
   * `client`: only the facts whose sources are all for the client (checked when the data is
   * read). Without it the content of a fact is worth the most restrictive category.
   */
  audience: z.enum(['internal', 'client']).optional(),
})

export const evidenceQuerySchema = z.strictObject({
  kind: z.literal('evidence'),
  documentKinds: z.array(z.enum(DOCUMENT_KINDS)).min(1).max(DOCUMENT_KINDS.length),
  /** Only the evidence with this audience; any when absent. */
  audience: z.enum(['internal', 'client']).optional(),
  period: paramRef.optional(),
})

export const parameterQuerySchema = z.strictObject({
  kind: z.literal('parameter'),
  parameter: recipeId,
})

export const querySchema = z.discriminatedUnion('kind', [
  trackerQuerySchema,
  systemRowsQuerySchema,
  factsQuerySchema,
  evidenceQuerySchema,
  parameterQuerySchema,
])
export type RecipeQuery = z.infer<typeof querySchema>

// Blocks -----------------------------------------------------------------------------------------

export const COLUMN_OPERATIONS = ['difference', 'ratio'] as const

export const columnSchema = z.strictObject({
  id: recipeId,
  title: label,
  /** A field of the rows the query gives, or an operation on two other columns of the block. */
  from: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('field'), field: z.string().min(1).max(100) }),
    z.strictObject({
      kind: z.enum(COLUMN_OPERATIONS),
      left: recipeId,
      right: recipeId,
    }),
  ]),
  category,
})
export type RecipeColumn = z.infer<typeof columnSchema>

const rowsBlock = {
  id: recipeId,
  title: label.optional(),
  query: querySchema,
  columns: z.array(columnSchema).min(1).max(MAX_COLUMNS),
  /** The columns that identify a row: decisions of the PM follow the row, not its position. */
  key: z.array(recipeId).min(1).max(5).optional(),
}

export const VALUE_OPERATIONS = ['count', 'sum', 'min', 'max', 'ratio', 'difference'] as const

export const valueComputeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('count'), block: recipeId }),
  z.strictObject({ op: z.enum(['sum', 'min', 'max']), column: columnRefSchema }),
  z.strictObject({
    op: z.enum(['ratio', 'difference']),
    left: valueRefSchema,
    right: valueRefSchema,
  }),
  z.strictObject({ op: z.literal('parameter'), parameter: recipeId }),
])
export type ValueCompute = z.infer<typeof valueComputeSchema>

export const blockSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('data_table'), ...rowsBlock }),
  z.strictObject({ kind: z.literal('data_list'), ...rowsBlock }),
  z.strictObject({
    kind: z.literal('data_value'),
    id: recipeId,
    label,
    compute: valueComputeSchema,
    category,
  }),
  z.strictObject({
    kind: z.literal('text_slot'),
    id: recipeId,
    title: label.optional(),
    instructions: text,
    natures: z.array(z.enum(NATURES)).min(1).max(NATURES.length),
    maxChars: z.int().min(1).max(MAX_SLOT_CHARS),
  }),
  /** A fixed text of the recipe: never a datum. */
  z.strictObject({ kind: z.literal('static'), id: recipeId, text }),
])
export type RecipeBlock = z.infer<typeof blockSchema>
export type BlockKind = RecipeBlock['kind']

export const sectionSchema = z.strictObject({
  id: recipeId,
  /** Data only as parameters, written `{{id}}`. */
  title: label,
  required: z.boolean(),
  version: z.enum(SECTION_VERSIONS),
  /** Whether the PM may remove the section from the recipe of the project. */
  removable: z.boolean(),
  blocks: z.array(blockSchema).min(1).max(MAX_BLOCKS_PER_SECTION),
})
export type RecipeSection = z.infer<typeof sectionSchema>

// Render -----------------------------------------------------------------------------------------

export const renderSchema = z.strictObject({
  /** `md` always, plus at most one binary format. */
  formats: z.array(z.enum(RENDER_FORMATS)).min(1).max(RENDER_FORMATS.length),
  /** The slug of a template of the library; the neutral one when null. */
  template: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,59}$/)
    .nullable(),
  sections: z
    .array(
      z.strictObject({
        section: recipeId,
        /** A paragraph style of the docx template. */
        style: label.optional(),
        /** A slide layout of the pptx template. */
        slideLayout: label.optional(),
        /** A sheet of the xlsx template. */
        sheet: label.optional(),
      }),
    )
    .max(MAX_SECTIONS),
  /** Named cells of the xlsx template, each filled by a value or a column. */
  namedCells: z
    .array(
      z.strictObject({
        name: z.string().regex(CELL_NAME),
        block: recipeId,
        column: recipeId.optional(),
      }),
    )
    .max(200),
})
export type RecipeRender = z.infer<typeof renderSchema>

// Recipe -----------------------------------------------------------------------------------------

export const extraCategorySchema = z.strictObject({
  block: recipeId,
  column: recipeId.optional(),
  category,
})

/** Rows a block leaves out, at most, and values one exclusion lists. */
export const MAX_EXCLUSIONS = 20
export const MAX_EXCLUDED_VALUES = 30

/**
 * Rows the PM asked to leave out of a rows block («escludi la US 27965»): the rows whose `field`
 * holds one of `values`. They are never hidden: the list block `shownIn`, in the same section,
 * shows them under «Escluso su richiesta del PM», with their sources.
 */
export const exclusionSchema = z.strictObject({
  block: recipeId,
  /** A field one of the columns of the block reads, so the excluded rows show it. */
  field: z.string().min(1).max(100),
  values: z.array(z.string().trim().min(1).max(MAX_LABEL_LENGTH)).min(1).max(MAX_EXCLUDED_VALUES),
  shownIn: recipeId,
})
export type RecipeExclusion = z.infer<typeof exclusionSchema>

export const recipeSchema = z.strictObject({
  schema: z.literal(RECIPE_SCHEMA),
  slug: z.string().regex(SLUG),
  version: z.string().regex(SEMVER),
  title: label,
  purpose: text,
  audience: z.enum(RECIPE_AUDIENCES),
  /**
   * For a recipe of both versions: the client version exists only when the PM answers this
   * choice with this option; skipped or answered otherwise, the deliverable is internal only.
   */
  clientVersionWhen: z.strictObject({ parameter: recipeId, equals: recipeId }).optional(),
  /** Checked against the languages the product knows: in M3 Italian only. */
  lang: z.string(),
  parameters: z.array(parameterSchema).max(MAX_PARAMETERS),
  prerequisites: z.array(prerequisiteSchema).max(MAX_PREREQUISITES),
  sections: z.array(sectionSchema).min(1).max(MAX_SECTIONS),
  /** Rules for the writer, read by the model only. */
  rules: z.array(text).max(MAX_RULES),
  checks: z.array(checkSchema).max(MAX_CHECKS),
  /** «Controlli del revisore», judged by the model: their anomalies are of class `data`. */
  redTeamRules: z.array(text).max(MAX_RULES),
  /** More restrictive labels on columns or values. */
  extraInternalCategories: z.array(extraCategorySchema).max(100),
  render: renderSchema,
  examples: z.array(z.strictObject({ title: label, summary: text })).max(MAX_EXAMPLES),
  /** Rows left out on request of the PM; absent in a recipe without any. */
  exclusions: z.array(exclusionSchema).max(MAX_EXCLUSIONS).optional(),
})

/** A recipe as parsed; `validateRecipe` is what makes it a valid one. */
export type Recipe = z.infer<typeof recipeSchema>
