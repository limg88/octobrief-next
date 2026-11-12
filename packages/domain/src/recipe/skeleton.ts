import { DomainError } from '../errors.ts'
import { fillTitle, rowKeysOf } from '../gate/audience.ts'
import { skeletonHash } from '../gate/fingerprints.ts'
import type { ContentHash } from '../pseudonym.ts'
import { type DataCategory, MOST_RESTRICTIVE_CATEGORY } from './categories.ts'
import type { ValueRef } from './checks.ts'
import {
  type DocumentCell,
  type DocumentSkeleton,
  type DocumentSourceRef,
  type SkeletonSection,
  skeletonSchema,
} from './document-model.ts'
import { excludedValue, exclusionOf, exclusionShownIn } from './exclusions.ts'
import type { Recipe, RecipeBlock, RecipeColumn, RecipeSection } from './format.ts'
import {
  type FieldValue,
  formatDay,
  formatNumber,
  formatPercent,
  type GatheredBlock,
  type GatheredData,
  type GatheredNote,
  type GatheredRow,
  notDeducedSections,
  type ParameterValue,
  periodText,
  shownNumber,
} from './gathered.ts'
import { canonicalJson } from './hash.ts'
import { recipeText } from './messages/index.ts'
import { effectiveCategory } from './validate.ts'
import { columnsReadFrom } from './warehouse-columns.ts'

// The skeleton of a deliverable: sections, tables, computed values and totals, each with its
// sources and its category, computed by the code from what was gathered. The model only writes
// the text slots. The same recipe@version and the same gathered data give the same skeleton, and
// so the same fingerprint. The skeleton is the internal one: the client version is projected from
// the internal document by the separation (`projectClientVersion`).

export type InternalSkeleton = Extract<DocumentSkeleton, { audience: 'internal' }>

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>
type ValueBlock = Extract<RecipeBlock, { kind: 'data_value' }>

/** Notes a cell or a value cites at most (the document admits no more). */
export const MAX_CELL_SOURCES = 20
const MAX_CELL_TEXT = 2_000
const MAX_NOTE_LABEL = 300

const cut = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** A computed figure: its number (when it is one), its text and the places it reads. */
interface Figure {
  number: number | null
  text: string | null
  refs: DocumentSourceRef[]
}

const NOT_DEDUCED: Figure = { number: null, text: null, refs: [] }

/** The numbers of the notes, given in the order places are first cited. */
class NoteBook {
  private readonly known = new Map<string, GatheredNote>()
  private readonly numbers = new Map<string, number>()
  readonly notes: InternalSkeleton['sourceNotes'] = []

  constructor(gathered: readonly GatheredNote[]) {
    for (const n of gathered) this.known.set(canonicalJson(n.ref), n)
  }

  cite(refs: readonly DocumentSourceRef[]): number[] {
    const out: number[] = []
    for (const ref of refs) {
      const key = canonicalJson(ref)
      let n = this.numbers.get(key)
      if (n === undefined) {
        // A row of the warehouse is read whole: its note is the row's, cited with its columns.
        const read =
          ref.kind === 'system_row' && ref.columns !== undefined
            ? canonicalJson({ ...ref, columns: undefined })
            : key
        const note = this.known.get(read)
        // Every place a figure cites was read: a place without its note is a defect, not a datum.
        if (!note) throw new DomainError('skeleton_note_unknown')
        n = this.notes.length + 1
        this.numbers.set(key, n)
        this.notes.push({
          n,
          label: cut(note.label, MAX_NOTE_LABEL),
          dataAsOf: note.dataAsOf,
          ref: structuredClone(ref),
        })
      }
      if (!out.includes(n)) out.push(n)
      if (out.length === MAX_CELL_SOURCES) break
    }
    return out
  }
}

/**
 * A row of the warehouse as the skeleton cites it: with the columns the recipe reads from its
 * view, the same whichever block reads it, so the row has one note and a text that cites it is
 * worth those columns and not every column of the view.
 */
function withColumns(ref: DocumentSourceRef, recipe: Recipe): DocumentSourceRef {
  if (ref.kind !== 'system_row') return ref
  const columns = columnsReadFrom(recipe, ref.view)
  return columns.length === 0 ? ref : { ...ref, columns }
}

const unique = (refs: readonly DocumentSourceRef[]): DocumentSourceRef[] => {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const k = canonicalJson(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

class Builder {
  private readonly lang
  private readonly titles: Readonly<Record<string, string>>
  private readonly blocks = new Map<string, { block: RecipeBlock; section: RecipeSection }>()
  private readonly notDeduced: Set<string>
  private readonly values = new Map<string, Figure>()
  private readonly cellsOf = new Map<string, Figure[][]>()
  readonly book: NoteBook

  private readonly recipe: Recipe
  private readonly gathered: GatheredData

  constructor(recipe: Recipe, gathered: GatheredData) {
    this.recipe = recipe
    this.gathered = gathered
    this.lang = gathered.lang
    this.titles = gathered.parameterTexts
    this.book = new NoteBook(gathered.notes)
    this.notDeduced = notDeducedSections(recipe, gathered.parameters)
    for (const section of recipe.sections) {
      for (const block of section.blocks) this.blocks.set(block.id, { block, section })
    }
  }

  title(t: string): string {
    return fillTitle(t, this.titles, this.lang)
  }

  private effective(block: string, column?: string): DataCategory {
    return effectiveCategory(this.recipe, block, column) ?? MOST_RESTRICTIVE_CATEGORY
  }

  private sectionNotDeduced(block: string): boolean {
    const s = this.blocks.get(block)?.section
    return s === undefined || this.notDeduced.has(s.id)
  }

  /**
   * What a rows block read, or null when it is «non dedotto». The rows the PM excluded leave the
   * block and are the rows of the list that shows them, read from the block they left; a total
   * of the source no longer counts what is shown, so the figures cite the rows.
   */
  private read(block: RowsBlock): Extract<GatheredBlock, { status: 'read' }> | null {
    if (this.sectionNotDeduced(block.id)) return null
    const shownIn = exclusionShownIn(this.recipe, block.id)
    const exclusion = shownIn ?? exclusionOf(this.recipe, block.id)
    const source = shownIn?.block ?? block.id
    const g = Object.hasOwn(this.gathered.blocks, source) ? this.gathered.blocks[source] : undefined
    if (g?.status !== 'read') return null
    if (exclusion === undefined) return g
    const keep = shownIn !== undefined
    const rows = g.rows.filter(
      (r) =>
        excludedValue(
          Object.hasOwn(r.values, exclusion.field) ? r.values[exclusion.field] : undefined,
          exclusion.values,
        ) === keep,
    )
    return { ...g, rows, totals: [] }
  }

  private text(value: FieldValue | undefined, category: DataCategory): string | null {
    if (value === undefined || value === null) return null
    if (typeof value === 'number') return formatNumber(value, category, this.lang)
    if (typeof value === 'boolean')
      return recipeText('gathering', value ? 'yes' : 'no', {}, this.lang)
    if (typeof value === 'string') return value.trim() === '' ? null : cut(value, MAX_CELL_TEXT)
    if (Array.isArray(value))
      return value.length === 0 ? null : cut(value.join(', '), MAX_CELL_TEXT)
    return formatDay((value as { day: string }).day)
  }

  /** The figure of one cell: a field as read at its place, or an operation on two fields. */
  private cell(block: RowsBlock, column: RecipeColumn, row: GatheredRow): Figure {
    const category = this.effective(block.id, column.id)
    const from = column.from
    if (from.kind === 'field') {
      const ref = Object.hasOwn(row.refs, from.field) ? row.refs[from.field] : undefined
      const value = Object.hasOwn(row.values, from.field) ? row.values[from.field] : undefined
      const text = ref === undefined ? null : this.text(value, category)
      if (text === null || ref === undefined) return NOT_DEDUCED
      return {
        number: typeof value === 'number' ? shownNumber(value) : null,
        text,
        refs: [withColumns(ref, this.recipe)],
      }
    }
    const operand = (id: string): Figure => {
      const c = block.columns.find((x) => x.id === id)
      return c === undefined || c.from.kind !== 'field' ? NOT_DEDUCED : this.cell(block, c, row)
    }
    const left = operand(from.left)
    const right = operand(from.right)
    if (left.number === null || right.number === null) return NOT_DEDUCED
    const refs = unique([...left.refs, ...right.refs])
    if (from.kind === 'difference') {
      const n = left.number - right.number
      return { number: n, text: formatNumber(n, category, this.lang), refs }
    }
    if (right.number === 0) return NOT_DEDUCED
    const n = left.number / right.number
    return { number: n, text: formatPercent(n, this.lang), refs }
  }

  /** The figures of every row of a rows block, computed once. */
  cells(block: RowsBlock): Figure[][] | null {
    const read = this.read(block)
    if (read === null) return null
    let out = this.cellsOf.get(block.id)
    if (!out) {
      out = read.rows.map((row) => block.columns.map((c) => this.cell(block, c, row)))
      this.cellsOf.set(block.id, out)
    }
    return out
  }

  /** The categories a cell of a column is made of: its column, or its two operand columns. */
  columnOperands(block: RowsBlock, column: RecipeColumn): DataCategory[] {
    if (column.from.kind === 'field') return [this.effective(block.id, column.id)]
    return [this.effective(block.id, column.from.left), this.effective(block.id, column.from.right)]
  }

  documentCell(figure: Figure, category: DataCategory, operands: DataCategory[]): DocumentCell {
    return {
      text: figure.text,
      category,
      operandCategories: operands,
      sources: figure.text === null ? [] : this.book.cite(figure.refs),
    }
  }

  private rowsBlock(id: string): RowsBlock | null {
    const b = this.blocks.get(id)?.block
    return b?.kind === 'data_table' || b?.kind === 'data_list' ? b : null
  }

  /** The places a total of a block cites: what the source counted, else the rows read. */
  private totalRefs(block: RowsBlock, figures: readonly Figure[]): DocumentSourceRef[] {
    const read = this.read(block)
    if (read && read.totals.length > 0) return [...read.totals]
    return unique(figures.flatMap((f) => f.refs))
  }

  private parameterFigure(id: string, category: DataCategory): Figure {
    const p = this.recipe.parameters.find((x) => x.id === id)
    if (!p || !Object.hasOwn(this.gathered.parameters, id)) return NOT_DEDUCED
    const v = this.gathered.parameters[id] as ParameterValue
    const refs: DocumentSourceRef[] = [{ kind: 'parameter', parameterId: id }]
    switch (v.type) {
      case 'number':
        return { number: v.value, text: formatNumber(v.value, category, this.lang), refs }
      case 'text':
        return { number: null, text: cut(v.value, MAX_CELL_TEXT), refs }
      case 'date':
        return { number: null, text: formatDay(v.day), refs }
      case 'period':
        return { number: null, text: periodText(v.from, v.to, this.lang), refs }
      case 'choice':
        return {
          number: null,
          text:
            p.type === 'choice'
              ? (p.options.find((o) => o.value === v.value)?.label ?? null)
              : null,
          refs,
        }
      default:
        return NOT_DEDUCED
    }
  }

  private operand(ref: ValueRef): Figure {
    if ('value' in ref) return this.value(ref.value)
    return this.parameterFigure(ref.parameter, 'other')
  }

  /** The figure of a computed value, computed once. */
  value(id: string): Figure {
    const known = this.values.get(id)
    if (known) return known
    // A cycle is refused by the validation; this keeps a defect from looping.
    this.values.set(id, NOT_DEDUCED)
    const figure = this.computeValue(id)
    this.values.set(id, figure)
    return figure
  }

  private computeValue(id: string): Figure {
    const b = this.blocks.get(id)?.block
    if (b?.kind !== 'data_value' || this.sectionNotDeduced(id)) return NOT_DEDUCED
    const category = this.effective(b.id)
    const c = b.compute
    switch (c.op) {
      case 'count': {
        const block = this.rowsBlock(c.block)
        const rows = block ? this.cells(block) : null
        if (!block || rows === null) return NOT_DEDUCED
        const read = this.read(block)
        // A row read without a place to cite would be counted without a source: fail closed.
        if (
          read &&
          read.totals.length === 0 &&
          read.rows.some((r) => Object.keys(r.refs).length === 0)
        ) {
          return NOT_DEDUCED
        }
        const refs = this.totalRefs(block, rows.flat())
        // Nothing counted and nothing that counted: no source for the figure.
        if (refs.length === 0) return NOT_DEDUCED
        return { number: rows.length, text: formatNumber(rows.length, 'other', this.lang), refs }
      }
      case 'sum':
      case 'min':
      case 'max': {
        const block = this.rowsBlock(c.column.block)
        const rows = block ? this.cells(block) : null
        const index = block ? block.columns.findIndex((x) => x.id === c.column.column) : -1
        if (!block || rows === null || index < 0 || rows.length === 0) return NOT_DEDUCED
        const figures = rows.map((r) => r[index] as Figure)
        // A total over a missing value would understate it: «non dedotto».
        if (figures.some((f) => f.number === null)) return NOT_DEDUCED
        const numbers = figures.map((f) => f.number as number)
        const n =
          c.op === 'sum'
            ? Math.round(numbers.reduce((a, x) => a + x, 0) * 1e6) / 1e6
            : c.op === 'min'
              ? numbers.reduce((a, x) => Math.min(a, x))
              : numbers.reduce((a, x) => Math.max(a, x))
        const columnCategory = this.effective(c.column.block, c.column.column)
        return {
          number: n,
          text: formatNumber(n, columnCategory, this.lang),
          refs: this.totalRefs(block, figures),
        }
      }
      case 'ratio':
      case 'difference': {
        const left = this.operand(c.left)
        const right = this.operand(c.right)
        if (left.number === null || right.number === null) return NOT_DEDUCED
        const refs = unique([...left.refs, ...right.refs])
        if (c.op === 'difference') {
          const n = left.number - right.number
          return { number: n, text: formatNumber(n, category, this.lang), refs }
        }
        if (right.number === 0) return NOT_DEDUCED
        const n = left.number / right.number
        return { number: n, text: formatPercent(n, this.lang), refs }
      }
      case 'parameter':
        return this.parameterFigure(c.parameter, category)
    }
  }

  /** The categories a computed value is made of, one per operand. */
  valueOperands(b: ValueBlock): DataCategory[] {
    const c = b.compute
    switch (c.op) {
      case 'count':
        return ['other']
      case 'sum':
      case 'min':
      case 'max':
        return [this.effective(c.column.block, c.column.column)]
      case 'ratio':
      case 'difference':
        return [c.left, c.right].map((r) => ('value' in r ? this.effective(r.value) : 'other'))
      case 'parameter':
        return [this.effective(b.id)]
    }
  }

  section(s: RecipeSection): SkeletonSection {
    const notDeduced = this.notDeduced.has(s.id)
    const blocks = s.blocks.map((b) => this.block(b))
    return { id: s.id, title: this.title(s.title), version: s.version, notDeduced, blocks }
  }

  private block(b: RecipeBlock): SkeletonSection['blocks'][number] {
    switch (b.kind) {
      case 'static':
        return { kind: 'static', id: b.id, text: b.text }
      case 'text_slot':
        return {
          kind: 'slot',
          id: b.id,
          ...(b.title === undefined ? {} : { title: this.title(b.title) }),
          natures: [...b.natures],
          maxChars: b.maxChars,
        }
      case 'data_value':
        return {
          kind: 'value',
          id: b.id,
          label: this.title(b.label),
          cell: this.documentCell(this.value(b.id), this.effective(b.id), this.valueOperands(b)),
        }
      case 'data_table':
      case 'data_list': {
        const figures = this.cells(b)
        const cells = (figures ?? []).map((row) =>
          row.map((f, i) => {
            const column = b.columns[i] as RecipeColumn
            return this.documentCell(
              f,
              this.effective(b.id, column.id),
              this.columnOperands(b, column),
            )
          }),
        )
        const ids = b.columns.map((c) => c.id)
        const keys = rowKeysOf(b, ids, cells)
        const rows = cells.map((rowCells, i) => ({ key: keys[i] as string, cells: rowCells }))
        const base = {
          id: b.id,
          ...(b.title === undefined ? {} : { title: this.title(b.title) }),
          columns: b.columns.map((c) => ({
            id: c.id,
            title: this.title(c.title),
            category: this.effective(b.id, c.id),
          })),
          notDeduced: figures === null,
        }
        return b.kind === 'data_table'
          ? { kind: 'table', ...base, rows }
          : { kind: 'list', ...base, items: rows }
      }
    }
  }
}

/**
 * The internal skeleton of a deliverable and its fingerprint, from the recipe and what the run
 * gathered: every section of the recipe in its order, every table and value computed by the
 * code with the notes of the places it read and the categories it is made of, the text slots
 * still to write. Row keys, titles and categories are made the way the client gate recomputes
 * them. A section that reads a mandatory parameter the PM skipped is «non dedotto», and so is
 * every figure of it; a figure without a source is «non dedotto», never a number.
 */
export function buildSkeleton(
  recipe: Recipe,
  gathered: GatheredData,
): { skeleton: InternalSkeleton; skeletonHash: ContentHash } {
  if (gathered.recipe.slug !== recipe.slug || gathered.recipe.version !== recipe.version) {
    throw new DomainError('skeleton_recipe_mismatch')
  }
  const b = new Builder(recipe, gathered)
  const sections = recipe.sections.map((s) => b.section(s))
  // The date of the data of the document: the oldest of what it cites, «non dedotto» (null) as
  // soon as one source it cites does not date its data.
  const cited = b.book.notes.filter((n) => n.ref.kind !== 'parameter')
  const dated = cited.some((n) => n.dataAsOf === null)
    ? []
    : cited.map((n) => Date.parse(n.dataAsOf as string))
  const skeleton: InternalSkeleton = {
    schema: 'octobrief.document/1',
    recipe: { slug: recipe.slug, version: recipe.version, title: recipe.title },
    audience: 'internal',
    lang: gathered.lang,
    title: b.title(recipe.title),
    header: {
      dataAsOf:
        dated.length === 0 ? null : new Date(dated.reduce((a, x) => Math.min(a, x))).toISOString(),
      generatedAt: new Date(gathered.referenceTime).toISOString(),
    },
    sections,
    sourceNotes: b.book.notes,
  }
  // The skeleton the code built must be a skeleton: anything else is a defect of the code.
  const parsed = skeletonSchema.safeParse(skeleton)
  if (!parsed.success) throw new DomainError('skeleton_malformed')
  return { skeleton, skeletonHash: skeletonHash(skeleton) }
}
