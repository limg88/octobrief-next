import type { z } from 'zod'
import { DomainError } from '../errors.ts'
import { tightenFreshness } from '../freshness.ts'
import { freshnessPolicyOf } from '../freshness-policy.ts'
import { LANGS, type Lang } from '../language/index.ts'
import { dataKindsIn } from '../numbers.ts'
import { WORK_ITEM_FIELDS } from '../tracker.ts'
import {
  computedDeclarationHolds,
  type DataCategory,
  DWSI_COLUMN_CATEGORIES,
  DWSI_VALUE_KINDS,
  declarationHolds,
  EVIDENCE_FIELDS,
  FACT_FIELDS,
  isMoreRestrictive,
  MOST_RESTRICTIVE_CATEGORY,
  mostRestrictiveOf,
  type SourceColumn,
  sourceColumnCategory,
  TRACKER_COUNT_FIELDS,
} from './categories.ts'
import type { ColumnRef, RecipeCheck, TargetRef, ValueRef } from './checks.ts'
import { excludedListTitle, shownFields } from './exclusions.ts'
import {
  MAX_PARAMETERS_PER_STEP,
  type Recipe,
  type RecipeBlock,
  type RecipeColumn,
  type RecipeParameter,
  type RecipeQuery,
  type RecipeSection,
  recipeSchema,
  TITLE_PARAMETER_TYPES,
  TITLE_PLACEHOLDER,
} from './format.ts'
import { canonicalJson } from './hash.ts'
import { MAIL_RECIPIENTS_PARAMETER } from './mail.ts'
import { recipeText } from './messages/index.ts'

export const RECIPE_ERROR_CODES = [
  'recipe_malformed',
  'recipe_unknown_field',
  'recipe_schema_unknown',
  'lang_not_supported',
  'column_without_category',
  'value_without_category',
  'section_duplicate',
  'block_duplicate',
  'column_duplicate',
  'parameter_duplicate',
  'check_duplicate',
  'option_duplicate',
  'parameters_too_many_at_once',
  'parameter_range_invalid',
  'parameter_unknown',
  'parameter_wrong_type',
  'parameter_not_for_content',
  'section_required_and_removable',
  'section_not_in_audience',
  'audience_without_sections',
  'title_with_data',
  'title_parameter_not_allowed',
  'static_with_data',
  'column_field_unknown',
  'column_operand_invalid',
  'column_category_looser',
  'key_column_unknown',
  'value_target_invalid',
  'value_category_looser',
  'value_cycle',
  'system_view_unknown',
  'system_column_unknown',
  'system_dates_column_invalid',
  'query_dates_conflict',
  'check_target_unknown',
  'check_not_applicable',
  'check_without_constraint',
  'freshness_looser_than_default',
  'freshness_invalid',
  'freshness_warn_after_stop',
  'freshness_on_document_source',
  'render_without_md',
  'render_too_many_binary',
  'render_format_duplicate',
  'render_template_without_binary',
  'render_mapping_wrong_format',
  'render_section_unknown',
  'render_cell_invalid',
  'render_cell_duplicate',
  'extra_category_target_unknown',
  'extra_category_not_stricter',
  'extra_category_duplicate',
  'number_not_supported',
  'exclusion_target_invalid',
  'exclusion_duplicate',
  'exclusion_not_shown',
  'client_version_condition_invalid',
] as const
export type RecipeErrorCode = (typeof RECIPE_ERROR_CODES)[number]

export type MessageParams = Readonly<Record<string, string | number>>

/**
 * One reason a recipe is not valid: a typed code, the PM-facing parameters of its message (titles
 * and labels, never identifiers) and, for the logs only, where it is.
 */
export interface RecipeError {
  code: RecipeErrorCode
  params: MessageParams
  path: string
}

export type RecipeValidation = { ok: true; recipe: Recipe } | { ok: false; errors: RecipeError[] }

/** The text of an error for the PM. */
export function recipeErrorText(error: RecipeError, lang: Lang): string {
  return recipeText('errors', error.code, error.params, lang)
}

const BINARY_FORMATS = ['docx', 'pptx', 'xlsx'] as const
/** Parameters with one value the PM types or picks. */
const SCALARS: readonly RecipeParameter['type'][] = ['text', 'date', 'period', 'choice', 'number']
const NUMERIC: readonly RecipeParameter['type'][] = ['number']
const ROW_BLOCKS: readonly RecipeBlock['kind'][] = ['data_table', 'data_list']

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>
type ValueBlock = Extract<RecipeBlock, { kind: 'data_value' }>

const pathOf = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')

/** The PM-facing name of what sits at `path` in the raw input: its title or label, if any. */
function nameAt(input: unknown, path: readonly PropertyKey[]): string {
  let node: unknown = input
  for (const key of path) {
    if (node === null || typeof node !== 'object') return ''
    node = (node as Record<PropertyKey, unknown>)[key]
  }
  if (node === null || typeof node !== 'object') return ''
  const n = node as Record<string, unknown>
  const name = n.title ?? n.label
  return typeof name === 'string' ? name : ''
}

/** A zod issue as an error of the recipe. */
function fromIssue(input: unknown, issue: z.core.$ZodIssue): RecipeError {
  const path = pathOf(issue.path)
  const last = issue.path.at(-1)
  if (issue.code === 'unrecognized_keys') {
    return { code: 'recipe_unknown_field', params: {}, path }
  }
  if (last === 'category') {
    const owner = issue.path.slice(0, -1)
    const isColumn = owner.includes('columns')
    return {
      code: isColumn ? 'column_without_category' : 'value_without_category',
      params: { name: nameAt(input, owner) },
      path,
    }
  }
  if (issue.path.length === 1 && last === 'schema') {
    return { code: 'recipe_schema_unknown', params: {}, path }
  }
  return { code: 'recipe_malformed', params: {}, path }
}

/**
 * Whether `input` is a valid recipe: the closed format, then every rule that holds across its
 * parts (unique ids and existing references, checks applicable to their targets, thresholds
 * never looser than the defaults, Italian only, a category on every column, declared views and
 * columns only, categories never looser than what the source holds).
 */
export function validateRecipe(input: unknown): RecipeValidation {
  const parsed = recipeSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => fromIssue(input, issue)) }
  }
  const errors = new Checker(parsed.data).run()
  return errors.length === 0 ? { ok: true, recipe: parsed.data } : { ok: false, errors }
}

/**
 * The category a column or a computed value is treated as: the one it declares, raised by the
 * more restrictive labels of `extraInternalCategories` (a label that is not more restrictive
 * never lowers it). Null when the recipe has no such column or value.
 */
export function effectiveCategory(
  recipe: Recipe,
  blockId: string,
  columnId?: string,
): DataCategory | null {
  let declared: DataCategory | null = null
  for (const section of recipe.sections) {
    const b = section.blocks.find((x) => x.id === blockId)
    if (b === undefined) continue
    if (b.kind === 'data_value' && columnId === undefined) declared = b.category
    if ((b.kind === 'data_table' || b.kind === 'data_list') && columnId !== undefined) {
      declared = b.columns.find((c) => c.id === columnId)?.category ?? null
    }
    break
  }
  if (declared === null) return null
  const base = declared
  const raises = recipe.extraInternalCategories
    .filter((e) => e.block === blockId && e.column === columnId)
    .map((e) => e.category)
    .filter((c) => isMoreRestrictive(c, base))
  return mostRestrictiveOf([base, ...raises])
}

interface Located<T> {
  value: T
  path: string
}

/** The path of the first number whose JavaScript form has an exponent (1e21, 1e-7); null if none. */
function numberInExponentForm(value: unknown, path = ''): string | null {
  if (typeof value === 'number') return /e/i.test(String(value)) ? path : null
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const found = numberInExponentForm(v, `${path}[${i}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const found = numberInExponentForm(v, `${path}.${k}`)
      if (found !== null) return found
    }
  }
  return null
}

class Checker {
  private readonly errors: RecipeError[] = []
  private readonly parameters = new Map<string, RecipeParameter>()
  private readonly blocks = new Map<string, Located<RecipeBlock> & { section: RecipeSection }>()

  private readonly recipe: Recipe

  constructor(recipe: Recipe) {
    this.recipe = recipe
  }

  run(): RecipeError[] {
    const r = this.recipe
    if (!(LANGS as readonly string[]).includes(r.lang)) {
      this.add('lang_not_supported', {}, '.lang')
    }
    // The database writes numbers as they are: one JavaScript writes in exponent form would get
    // another fingerprint there.
    const exponent = numberInExponentForm(r)
    if (exponent !== null) this.add('number_not_supported', {}, exponent)
    this.indexParameters()
    this.checkPrerequisites()
    this.indexBlocks()
    r.sections.forEach((s, i) => {
      this.checkSection(s, `.sections[${i}]`)
    })
    this.checkValueCycles()
    const checkIds = new Set<string>()
    r.checks.forEach((c, i) => {
      const path = `.checks[${i}]`
      if (checkIds.has(c.id)) this.add('check_duplicate', { name: c.label }, path)
      checkIds.add(c.id)
      this.checkCheck(c, path)
    })
    this.checkExtraCategories()
    this.checkExclusions()
    this.checkRender()
    this.checkClientVersionCondition()
    return this.errors
  }

  private add(code: RecipeErrorCode, params: MessageParams, path: string): void {
    this.errors.push({ code, params, path })
  }

  // Parameters and prerequisites -----------------------------------------------------------------

  private indexParameters(): void {
    const perStep = new Map<number, number>()
    this.recipe.parameters.forEach((p, i) => {
      const path = `.parameters[${i}]`
      if (this.parameters.has(p.id)) this.add('parameter_duplicate', { name: p.label }, path)
      else this.parameters.set(p.id, p)
      // The recipients of a mail are a text of the PM and nothing else.
      if (p.id === MAIL_RECIPIENTS_PARAMETER && p.type !== 'text') {
        this.add('parameter_wrong_type', { name: p.label }, path)
      }
      perStep.set(p.step, (perStep.get(p.step) ?? 0) + 1)
      if (p.type === 'number' && p.min !== undefined && p.max !== undefined && p.min > p.max) {
        this.add('parameter_range_invalid', { name: p.label }, path)
      }
      if (p.type === 'choice') {
        const values = p.options.map((o) => o.value)
        if (new Set(values).size !== values.length) {
          this.add('option_duplicate', { name: p.label }, path)
        }
      }
      if (p.type === 'rows') this.checkRowsParameter(p, path)
    })
    this.recipe.parameters.forEach((p, i) => {
      if (p.type !== 'rows') return
      const path = `.parameters[${i}]`
      if (p.evidence !== undefined) {
        this.parameterRef(p.evidence, ['evidence_selection'], `${path}.evidence`)
      }
      for (const k of p.key ?? []) {
        if (!p.columns.some((c) => c.id === k)) this.add('key_column_unknown', {}, `${path}.key`)
      }
    })
    for (const [step, count] of [...perStep].sort(([a], [b]) => a - b)) {
      if (count > MAX_PARAMETERS_PER_STEP) {
        this.add(
          'parameters_too_many_at_once',
          { step, count, max: MAX_PARAMETERS_PER_STEP },
          '.parameters',
        )
      }
    }
  }

  /** The columns of a table of the PM: unique ids, ranges that hold. */
  private checkRowsParameter(p: Extract<RecipeParameter, { type: 'rows' }>, path: string): void {
    const ids = new Set<string>()
    p.columns.forEach((c, i) => {
      const cPath = `${path}.columns[${i}]`
      if (ids.has(c.id)) this.add('column_duplicate', { name: c.label }, cPath)
      ids.add(c.id)
      if (c.kind === 'number' && c.min !== undefined && c.max !== undefined && c.min > c.max) {
        this.add('parameter_range_invalid', { name: p.label }, cPath)
      }
    })
  }

  private checkPrerequisites(): void {
    this.recipe.prerequisites.forEach((p, i) => {
      if (p.kind !== 'source' || p.freshness === undefined) return
      const path = `.prerequisites[${i}].freshness`
      if (p.sourceKinds.some((k) => freshnessPolicyOf(k, null) !== 'system')) {
        this.add('freshness_on_document_source', {}, path)
      }
      try {
        tightenFreshness(p.freshness)
      } catch (e) {
        const code = e instanceof DomainError ? e.code : 'freshness_invalid'
        this.add(
          code === 'freshness_looser_than_default' || code === 'freshness_warn_after_stop'
            ? code
            : 'freshness_invalid',
          { warn: 24, stop: 72 },
          path,
        )
      }
    })
  }

  /** A parameter referenced somewhere, of one of `types` when given. */
  private parameterRef(
    id: string,
    types: readonly RecipeParameter['type'][] | null,
    path: string,
  ): RecipeParameter | undefined {
    const p = this.parameters.get(id)
    if (!p) {
      this.add('parameter_unknown', {}, path)
      return undefined
    }
    // The addresses of the recipients go to the PM, never into a title, a filter, a cell or a
    // calculation: those reach the model and the file.
    if (id === MAIL_RECIPIENTS_PARAMETER) {
      this.add('parameter_not_for_content', { name: p.label }, path)
      return undefined
    }
    if (types !== null && !types.includes(p.type)) {
      this.add('parameter_wrong_type', { name: p.label }, path)
      return undefined
    }
    return p
  }

  // Sections and blocks --------------------------------------------------------------------------

  private indexBlocks(): void {
    const sectionIds = new Set<string>()
    this.recipe.sections.forEach((s, i) => {
      const path = `.sections[${i}]`
      if (sectionIds.has(s.id)) this.add('section_duplicate', { section: s.title }, path)
      sectionIds.add(s.id)
      s.blocks.forEach((b, j) => {
        const bPath = `${path}.blocks[${j}]`
        if (this.blocks.has(b.id)) {
          this.add('block_duplicate', { section: s.title }, bPath)
          return
        }
        this.blocks.set(b.id, { value: b, path: bPath, section: s })
      })
    })
    const audience = this.recipe.audience
    const shown = this.recipe.sections.some(
      (s) => audience === 'both' || s.version === 'both' || s.version === audience,
    )
    if (!shown) this.add('audience_without_sections', {}, '.sections')
  }

  private checkSection(s: RecipeSection, path: string): void {
    if (s.required && s.removable) {
      this.add('section_required_and_removable', { section: s.title }, path)
    }
    if (this.recipe.audience === 'internal' && s.version === 'client') {
      this.add('section_not_in_audience', { section: s.title }, path)
    }
    this.checkTitle(s.title, s.title, `${path}.title`)
    s.blocks.forEach((b, j) => {
      this.checkBlock(b, s, `${path}.blocks[${j}]`)
    })
  }

  /** A title holds data only as parameters: the literal text around them holds none. */
  private checkTitle(title: string, section: string, path: string): void {
    for (const [, id] of title.matchAll(TITLE_PLACEHOLDER)) {
      if (id === undefined) continue
      const p = this.parameterRef(id, null, path)
      if (p && !TITLE_PARAMETER_TYPES.includes(p.type)) {
        this.add('title_parameter_not_allowed', { section, name: p.label }, path)
      }
    }
    if (this.holdsData(title.replace(TITLE_PLACEHOLDER, ' '))) {
      this.add('title_with_data', { section }, path)
    }
  }

  private holdsData(text: string): boolean {
    const lang = this.lang()
    return lang !== null && dataKindsIn(text, lang).length > 0
  }

  private lang(): Lang | null {
    return (LANGS as readonly string[]).includes(this.recipe.lang)
      ? (this.recipe.lang as Lang)
      : null
  }

  private checkBlock(b: RecipeBlock, s: RecipeSection, path: string): void {
    switch (b.kind) {
      case 'data_table':
      case 'data_list':
        this.checkRowsBlock(b, path)
        break
      case 'data_value':
        this.checkValue(b, path)
        break
      case 'text_slot':
        if (b.title !== undefined) this.checkTitle(b.title, s.title, `${path}.title`)
        break
      case 'static':
        if (this.holdsData(b.text)) this.add('static_with_data', { section: s.title }, path)
        break
    }
  }

  private checkRowsBlock(b: RowsBlock, path: string): void {
    const source = this.rowSource(b.query, `${path}.query`)
    const columns = new Map<string, RecipeColumn>()
    b.columns.forEach((c, i) => {
      if (columns.has(c.id))
        this.add('column_duplicate', { name: c.title }, `${path}.columns[${i}]`)
      columns.set(c.id, c)
    })
    b.columns.forEach((c, i) => {
      const cPath = `${path}.columns[${i}]`
      if (c.from.kind === 'field') {
        if (source === null) return
        const sourceColumn = source(c.from.field)
        if (sourceColumn === null) {
          this.add('column_field_unknown', { name: c.title }, cPath)
          return
        }
        const held = sourceColumnCategory(sourceColumn)
        if (!declarationHolds(c.category, held)) {
          this.add('column_category_looser', { name: c.title, category: held }, cPath)
        }
        return
      }
      const operands = [c.from.left, c.from.right].map((id) => columns.get(id))
      const valid = operands.every(
        (o): o is RecipeColumn => o !== undefined && o.id !== c.id && o.from.kind === 'field',
      )
      if (!valid) {
        this.add('column_operand_invalid', { name: c.title }, cPath)
        return
      }
      const held = (operands as RecipeColumn[]).map((o) => this.effective(b.id, o.id))
      if (!computedDeclarationHolds(c.category, held)) {
        this.add(
          'column_category_looser',
          { name: c.title, category: mostRestrictiveOf(held) },
          cPath,
        )
      }
    })
    for (const k of b.key ?? []) {
      if (!columns.has(k)) this.add('key_column_unknown', {}, `${path}.key`)
    }
  }

  /**
   * The source column behind each field of the rows a query gives, or null for a field it does
   * not give; null when the query itself is not valid.
   */
  private rowSource(q: RecipeQuery, path: string): ((field: string) => SourceColumn | null) | null {
    const among = (fields: readonly string[], f: string) => fields.includes(f)
    switch (q.kind) {
      case 'tracker': {
        this.checkTrackerQuery(q, path)
        if (q.groupBy !== undefined) {
          const groupBy = q.groupBy
          return (f) =>
            among(TRACKER_COUNT_FIELDS, f) ? { source: 'tracker_counts', field: f, groupBy } : null
        }
        return (f) =>
          f === 'id' || among(WORK_ITEM_FIELDS, f) ? { source: 'tracker', field: f } : null
      }
      case 'system_rows': {
        const view = Object.hasOwn(DWSI_COLUMN_CATEGORIES, q.view)
          ? DWSI_COLUMN_CATEGORIES[q.view]
          : undefined
        if (view === undefined) {
          this.add('system_view_unknown', {}, `${path}.view`)
          return null
        }
        q.where?.forEach((w, i) => {
          const wPath = `${path}.where[${i}]`
          if (!Object.hasOwn(view, w.column)) this.add('system_column_unknown', {}, wPath)
          if (typeof w.equals === 'object') this.parameterRef(w.equals.parameter, SCALARS, wPath)
        })
        if (q.dates !== undefined) {
          const kinds = DWSI_VALUE_KINDS[q.view] ?? {}
          if (!Object.hasOwn(kinds, q.dates.column) || kinds[q.dates.column] !== 'day') {
            this.add('system_dates_column_invalid', {}, `${path}.dates`)
          }
          this.parameterRef(q.dates.period.parameter, ['period'], `${path}.dates`)
        }
        return (f) =>
          Object.hasOwn(view, f) ? { source: 'system_rows', view: q.view, column: f } : null
      }
      case 'facts': {
        const clientOnly = q.audience === 'client'
        return (f) =>
          among(FACT_FIELDS, f)
            ? { source: 'facts', factKind: q.factKind, field: f, clientOnly }
            : null
      }
      case 'evidence': {
        if (q.period !== undefined) this.parameterRef(q.period.parameter, ['period'], path)
        const clientOnly = q.audience === 'client'
        return (f) =>
          among(EVIDENCE_FIELDS, f) ? { source: 'evidence', field: f, clientOnly } : null
      }
      case 'parameter': {
        const p = this.parameterRef(q.parameter, null, `${path}.parameter`)
        if (!p) return null
        if (p.type === 'work_item_selection') {
          return (f) =>
            f === 'id' || among(WORK_ITEM_FIELDS, f) ? { source: 'tracker', field: f } : null
        }
        if (p.type === 'evidence_selection') {
          return (f) =>
            among(EVIDENCE_FIELDS, f) ? { source: 'evidence', field: f, clientOnly: false } : null
        }
        if (p.type === 'rows') {
          const columns = p.columns.map((c) => c.id)
          return (f) => (among(columns, f) ? { source: 'parameter' } : null)
        }
        return (f) => (f === 'value' ? { source: 'parameter' } : null)
      }
    }
  }

  private checkTrackerQuery(q: Extract<RecipeQuery, { kind: 'tracker' }>, path: string): void {
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
      for (const v of list ?? []) {
        if (typeof v !== 'object') continue
        const p = this.parameterRef(v.parameter, ['text', 'choice', 'rows'], path)
        // A list of values the PM gives is a table of one text column.
        if (p?.type === 'rows' && (p.columns.length !== 1 || p.columns[0]?.kind !== 'text')) {
          this.add('parameter_wrong_type', { name: p.label }, path)
        }
      }
    }
    const d = q.decisions
    if (d?.excluded !== undefined) {
      this.parameterRef(d.excluded.parameter, ['work_item_selection'], `${path}.decisions`)
    }
    if (d?.attributions !== undefined) {
      const a = d.attributions
      const p = this.parameterRef(a.parameter, ['rows'], `${path}.decisions`)
      if (p?.type === 'rows') {
        for (const id of [a.item, a.parent, ...(a.source === undefined ? [] : [a.source])]) {
          if (!p.columns.some((c) => c.id === id && c.kind === 'text')) {
            this.add('column_field_unknown', { name: p.label }, `${path}.decisions`)
          }
        }
      }
    }
    const dates = f.dates
    if (dates === undefined) return
    // A date asked for and its absence at once: no work item could ever match.
    if (f.undated === dates.field) this.add('query_dates_conflict', {}, `${path}.filter.undated`)
    if (dates.period !== undefined) {
      if (dates.from !== undefined || dates.to !== undefined) {
        this.add('query_dates_conflict', {}, `${path}.filter.dates`)
      }
      this.parameterRef(dates.period.parameter, ['period'], path)
    }
    for (const end of [dates.from, dates.to]) {
      if (typeof end === 'object') this.parameterRef(end.parameter, ['date'], path)
    }
  }

  // Computed values -------------------------------------------------------------------------------

  private checkValue(b: ValueBlock, path: string): void {
    const c = b.compute
    const held: DataCategory[] = []
    let computed = false
    switch (c.op) {
      case 'count':
        if (!this.rowsBlock(c.block)) this.add('value_target_invalid', { name: b.label }, path)
        break
      case 'sum':
      case 'min':
      case 'max': {
        const column = this.column(c.column)
        if (column === null) this.add('value_target_invalid', { name: b.label }, path)
        else held.push(this.effective(c.column.block, c.column.column))
        break
      }
      case 'ratio':
      case 'difference':
        computed = true
        for (const ref of [c.left, c.right]) {
          const category = this.valueRef(ref, NUMERIC, path)
          if (category === null) this.add('value_target_invalid', { name: b.label }, path)
          else held.push(category)
        }
        break
      case 'parameter':
        if (!this.parameterRef(c.parameter, SCALARS, path)) return
        break
    }
    if (computed) {
      if (held.length === 2 && !computedDeclarationHolds(b.category, held)) {
        this.add(
          'value_category_looser',
          { name: b.label, category: mostRestrictiveOf(held) },
          path,
        )
      }
      return
    }
    const looser = held.find((h) => !declarationHolds(b.category, h))
    if (looser !== undefined) {
      this.add('value_category_looser', { name: b.label, category: looser }, path)
    }
  }

  private checkValueCycles(): void {
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (id: string): boolean => {
      if (state.get(id) === 'done') return false
      if (state.get(id) === 'visiting') return true
      state.set(id, 'visiting')
      const b = this.blocks.get(id)?.value
      let cycle = false
      if (b?.kind === 'data_value' && (b.compute.op === 'ratio' || b.compute.op === 'difference')) {
        for (const ref of [b.compute.left, b.compute.right]) {
          if ('value' in ref && visit(ref.value)) cycle = true
        }
      }
      state.set(id, 'done')
      return cycle
    }
    for (const [id, located] of this.blocks) {
      if (located.value.kind !== 'data_value' || state.has(id)) continue
      if (visit(id)) this.add('value_cycle', { name: located.value.label }, located.path)
    }
  }

  private rowsBlock(id: string): RowsBlock | null {
    const b = this.blocks.get(id)?.value
    return b !== undefined && ROW_BLOCKS.includes(b.kind) ? (b as RowsBlock) : null
  }

  private effective(blockId: string, columnId?: string): DataCategory {
    return effectiveCategory(this.recipe, blockId, columnId) ?? MOST_RESTRICTIVE_CATEGORY
  }

  /** Whether a computed value block gives a number. */
  private numericValue(b: ValueBlock): boolean {
    if (b.compute.op !== 'parameter') return true
    return this.parameters.get(b.compute.parameter)?.type === 'number'
  }

  /** Whether a column of a rows block holds numbers: a computation, or a numeric source field. */
  private numericColumn(blockId: string, columnId: string): boolean {
    const b = this.rowsBlock(blockId)
    const c = b?.columns.find((x) => x.id === columnId)
    if (!b || !c) return false
    if (c.from.kind !== 'field') return true
    const field = c.from.field
    const q = b.query
    switch (q.kind) {
      case 'system_rows':
        return DWSI_VALUE_KINDS[q.view]?.[field] === 'number'
      case 'tracker':
        return field === 'story_points' || (q.groupBy !== undefined && field === 'count')
      case 'parameter': {
        const p = this.parameters.get(q.parameter)
        if (p?.type === 'rows') return p.columns.some((x) => x.id === field && x.kind === 'number')
        return p?.type === 'number' && field === 'value'
      }
      default:
        return false
    }
  }

  private column(ref: ColumnRef): RecipeColumn | null {
    return this.rowsBlock(ref.block)?.columns.find((c) => c.id === ref.column) ?? null
  }

  /** The category of a single value, or null when the reference does not name one of `types`. */
  private valueRef(
    ref: ValueRef,
    types: readonly RecipeParameter['type'][],
    path: string,
  ): DataCategory | null {
    if ('value' in ref) {
      const b = this.blocks.get(ref.value)?.value
      if (b?.kind !== 'data_value') return null
      if (types === NUMERIC && !this.numericValue(b)) return null
      return this.effective(b.id)
    }
    return this.parameterRef(ref.parameter, types, path) ? 'other' : null
  }

  // Checks ---------------------------------------------------------------------------------------

  private checkCheck(c: RecipeCheck, path: string): void {
    const name = { name: c.label }
    const unknown = () => this.add('check_target_unknown', name, path)
    const notApplicable = () => this.add('check_not_applicable', name, path)
    /** The recipients of a mail are never compared or counted: refused here as everywhere. */
    const recipients = (id: string): boolean => {
      if (id !== MAIL_RECIPIENTS_PARAMETER) return false
      this.add('parameter_not_for_content', { name: this.parameters.get(id)?.label ?? id }, path)
      return true
    }
    /** A column of a table or a list; false when it is not one (and the error is recorded). */
    const rows = (id: string): RowsBlock | null => {
      const b = this.blocks.get(id)?.value
      if (b === undefined) unknown()
      else if (!ROW_BLOCKS.includes(b.kind)) notApplicable()
      else return b as RowsBlock
      return null
    }
    const column = (ref: ColumnRef): boolean => {
      const b = rows(ref.block)
      if (b === null) return false
      if (b.columns.some((col) => col.id === ref.column)) return true
      unknown()
      return false
    }
    const value = (ref: ValueRef, types: readonly RecipeParameter['type'][]): void => {
      if ('value' in ref) {
        const b = this.blocks.get(ref.value)?.value
        if (b === undefined) unknown()
        else if (b.kind !== 'data_value') notApplicable()
        else if (types === NUMERIC && !this.numericValue(b)) notApplicable()
        return
      }
      if (recipients(ref.parameter)) return
      const p = this.parameters.get(ref.parameter)
      if (p === undefined) unknown()
      else if (!types.includes(p.type)) notApplicable()
    }
    const target = (ref: TargetRef): void => {
      const b = this.blocks.get(ref.block)?.value
      if (b === undefined) unknown()
      else if (b.kind === 'data_value') {
        if (ref.column !== undefined) notApplicable()
      } else if (ref.column === undefined) notApplicable()
      else column({ block: ref.block, column: ref.column })
    }
    switch (c.kind) {
      case 'sum_equals':
        if (column(c.column)) value(c.equals, NUMERIC)
        break
      case 'sum_at_most':
        if (column(c.column)) value(c.atMost, NUMERIC)
        break
      case 'difference_equals': {
        const b = rows(c.block)
        if (b === null) break
        const ids = [c.result, c.minuend, c.subtrahend]
        if (!ids.every((id) => b.columns.some((col) => col.id === id))) unknown()
        break
      }
      case 'values_equal':
        value(c.left, SCALARS)
        value(c.right, SCALARS)
        break
      case 'present': {
        const b = this.blocks.get(c.block)?.value
        if (b === undefined) unknown()
        else if (b.kind === 'text_slot' || b.kind === 'static') notApplicable()
        break
      }
      case 'member_of':
        if (column(c.column)) column(c.in)
        break
      case 'count_consistent':
        if (rows(c.block) !== null) value(c.count, NUMERIC)
        break
      case 'date_within_period': {
        if (!column(c.column)) break
        if (recipients(c.period)) break
        const p = this.parameters.get(c.period)
        if (p === undefined) unknown()
        else if (p.type !== 'period') notApplicable()
        break
      }
      case 'unique':
        column(c.column)
        break
      case 'coverage':
        if (column(c.universe)) c.coveredBy.every((ref) => column(ref))
        break
      case 'implies': {
        const b = rows(c.block)
        if (b === null) break
        if (
          ![c.condition.column, c.consequence.column].every((id) =>
            b.columns.some((col) => col.id === id),
          )
        ) {
          unknown()
        }
        break
      }
      case 'equals_previous':
        target(c.current)
        target(c.previous)
        break
      case 'bounded_text': {
        const b = this.blocks.get(c.slot)?.value
        if (b === undefined) unknown()
        else if (b.kind !== 'text_slot') notApplicable()
        else if (
          c.maxChars === undefined &&
          c.forbiddenPhrases.length === 0 &&
          !c.connectorsWithoutData
        ) {
          this.add('check_without_constraint', name, path)
        }
        break
      }
      case 'agree_by_key':
      case 'sum_by_key': {
        const sides = c.kind === 'agree_by_key' ? [c.left, c.right] : [c.rows, c.totals]
        let known = true
        for (const side of sides) {
          if (!column({ block: side.block, column: side.key })) known = false
          else if (!column({ block: side.block, column: side.value })) known = false
          if (!known) break
        }
        if (!known) break
        // Two tables, and figures to compare: the same table, or a text, compares nothing.
        const figures = sides.every((side) => this.numericColumn(side.block, side.value))
        if (sides[0]?.block === sides[1]?.block || !figures) notApplicable()
        break
      }
      case 'all_equal_when':
        value(c.when.value, NUMERIC)
        column(c.column)
        break
      case 'segments_cited':
      case 'segment_fields': {
        const b = this.blocks.get(c.slot)?.value
        if (b === undefined) unknown()
        else if (b.kind !== 'text_slot') notApplicable()
        if (c.parameter === undefined) break
        // Narrowed to a selection of evidence that a block of the draft lists.
        if (!this.parameterRef(c.parameter, ['evidence_selection'], path)) break
        const listed = [...this.blocks.values()].some(
          ({ value: x }) =>
            (x.kind === 'data_list' || x.kind === 'data_table') &&
            x.query.kind === 'parameter' &&
            x.query.parameter === c.parameter,
        )
        if (!listed || !c.sourceKinds.includes('evidence')) notApplicable()
        break
      }
    }
  }

  // Categories and render ------------------------------------------------------------------------

  private checkExtraCategories(): void {
    const seen = new Set<string>()
    this.recipe.extraInternalCategories.forEach((e, i) => {
      const path = `.extraInternalCategories[${i}]`
      const key = `${e.block}\u001f${e.column ?? ''}`
      if (seen.has(key)) this.add('extra_category_duplicate', {}, path)
      seen.add(key)
      const b = this.blocks.get(e.block)?.value
      let declared: DataCategory | null = null
      let name = ''
      if (b?.kind === 'data_value' && e.column === undefined) {
        declared = b.category
        name = b.label
      } else if (b !== undefined && ROW_BLOCKS.includes(b.kind) && e.column !== undefined) {
        const col = (b as RowsBlock).columns.find((c) => c.id === e.column)
        if (col) {
          declared = col.category
          name = col.title
        }
      }
      if (declared === null) {
        this.add('extra_category_target_unknown', {}, path)
        return
      }
      if (!isMoreRestrictive(e.category, declared)) {
        this.add('extra_category_not_stricter', { name, category: declared }, path)
      }
    })
  }

  /**
   * An exclusion leaves rows out of a rows block by a field the block shows, and the list of the
   * excluded rows is in the same section, with the same query, columns and key, under its fixed
   * title: what is excluded is always shown.
   */
  private checkExclusions(): void {
    const exclusions = this.recipe.exclusions ?? []
    const lang = this.lang()
    const targets = new Set<string>()
    const lists = new Set(exclusions.map((e) => e.shownIn))
    const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
    // The internal labels of a block, by column: the excluded rows keep them.
    const labelsOf = (block: string) =>
      this.recipe.extraInternalCategories
        .filter((x) => x.block === block)
        .map((x) => `${x.column ?? ''}\u001f${x.category}`)
        .sort()
    exclusions.forEach((e, i) => {
      const path = `.exclusions[${i}]`
      if (targets.has(e.block)) this.add('exclusion_duplicate', {}, path)
      targets.add(e.block)
      const target = this.blocks.get(e.block)
      const block = target?.value
      if (
        target === undefined ||
        block === undefined ||
        (block.kind !== 'data_table' && block.kind !== 'data_list') ||
        lists.has(e.block) ||
        !shownFields(block).includes(e.field)
      ) {
        this.add('exclusion_target_invalid', {}, path)
        return
      }
      const list = this.blocks.get(e.shownIn)
      const shown =
        list !== undefined &&
        list.value.kind === 'data_list' &&
        list.section.id === target.section.id &&
        e.shownIn !== e.block &&
        lang !== null &&
        list.value.title === excludedListTitle(lang) &&
        same(list.value.query, block.query) &&
        same(list.value.columns, block.columns) &&
        same(list.value.key, block.key) &&
        same(labelsOf(e.block), labelsOf(e.shownIn))
      if (!shown) {
        this.add('exclusion_not_shown', { name: block.title ?? target.section.title }, path)
      }
    })
  }

  /** A choice of the PM, on a recipe of both versions, naming one of its options. */
  private checkClientVersionCondition(): void {
    const when = this.recipe.clientVersionWhen
    if (when === undefined) return
    const path = '.clientVersionWhen'
    if (this.recipe.audience !== 'both') {
      this.add('client_version_condition_invalid', {}, path)
      return
    }
    const p = this.parameterRef(when.parameter, ['choice'], path)
    if (p?.type === 'choice' && !p.options.some((o) => o.value === when.equals)) {
      this.add('client_version_condition_invalid', {}, path)
    }
  }

  private checkRender(): void {
    const r = this.recipe.render
    if (!r.formats.includes('md')) this.add('render_without_md', {}, '.render.formats')
    if (new Set(r.formats).size !== r.formats.length) {
      this.add('render_format_duplicate', {}, '.render.formats')
    }
    const binary = BINARY_FORMATS.filter((f) => r.formats.includes(f))
    if (binary.length > 1) this.add('render_too_many_binary', {}, '.render.formats')
    if (r.template !== null && binary.length === 0) {
      this.add('render_template_without_binary', {}, '.render.template')
    }
    const sections = new Map(this.recipe.sections.map((s) => [s.id, s]))
    r.sections.forEach((m, i) => {
      const path = `.render.sections[${i}]`
      const s = sections.get(m.section)
      if (!s) {
        this.add('render_section_unknown', {}, path)
        return
      }
      const wrong =
        (m.style !== undefined && !binary.includes('docx')) ||
        (m.slideLayout !== undefined && !binary.includes('pptx')) ||
        (m.sheet !== undefined && !binary.includes('xlsx'))
      if (wrong) this.add('render_mapping_wrong_format', { section: s.title }, path)
    })
    const names = new Set<string>()
    r.namedCells.forEach((cell, i) => {
      const path = `.render.namedCells[${i}]`
      if (names.has(cell.name)) this.add('render_cell_duplicate', {}, path)
      names.add(cell.name)
      const b = this.blocks.get(cell.block)?.value
      const valid =
        binary.includes('xlsx') &&
        ((b?.kind === 'data_value' && cell.column === undefined) ||
          (cell.column !== undefined && this.column({ block: cell.block, column: cell.column })))
      if (!valid) this.add('render_cell_invalid', {}, path)
    })
  }
}
