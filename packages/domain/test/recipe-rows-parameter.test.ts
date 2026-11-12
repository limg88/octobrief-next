import { describe, expect, it } from 'vitest'
import {
  buildSkeleton,
  checkParameterValues,
  DomainError,
  type GatheredData,
  type ParameterValue,
  parameterErrorText,
  typedRowsRead,
  validateProjectRecipeSettings,
  validateRecipe,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleGathered } from './support/gathered.ts'
import { sampleRecipe } from './support/recipes.ts'

// A table the PM types (the lines of an order): declared columns, «indicato da te», never filled
// by the model.

const LINES = {
  id: 'lines',
  type: 'rows',
  label: "Posizioni dell'ordine",
  required: true,
  step: 2,
  maxRows: 3,
  columns: [
    { id: 'position', label: 'Posizione', kind: 'text', maxLength: 20 },
    { id: 'amount', label: 'Importo', kind: 'number', integer: false, min: 0 },
    { id: 'due', label: 'Scadenza', kind: 'date' },
  ],
}

function withLines(): ReturnType<typeof sampleRecipe> {
  const raw = sampleRecipe()
  raw.parameters.push(structuredClone(LINES))
  raw.sections.push({
    id: 'lines_section',
    title: 'Posizioni indicate',
    required: false,
    version: 'both',
    removable: true,
    blocks: [
      {
        kind: 'data_table',
        id: 'typed_lines',
        query: { kind: 'parameter', parameter: 'lines' },
        key: ['position'],
        columns: [
          {
            id: 'position',
            title: 'Posizione',
            from: { kind: 'field', field: 'position' },
            category: 'other',
          },
          {
            id: 'amount',
            title: 'Importo',
            from: { kind: 'field', field: 'amount' },
            category: 'contract_amounts',
          },
          {
            id: 'due',
            title: 'Scadenza',
            from: { kind: 'field', field: 'due' },
            category: 'other',
          },
        ],
      },
      {
        kind: 'data_value',
        id: 'typed_total',
        label: 'Totale indicato',
        compute: { op: 'sum', column: { block: 'typed_lines', column: 'amount' } },
        category: 'contract_amounts',
      },
    ],
  })
  return raw
}

const codesOf = (raw: unknown) => {
  const v = validateRecipe(raw)
  return v.ok ? [] : v.errors.map((e) => e.code)
}

const rows = (...r: Array<Record<string, string | number>>): ParameterValue => ({
  type: 'rows',
  rows: r,
})

describe('a table typed by the PM', () => {
  it('is a valid parameter whose columns a block reads, and only those', () => {
    expect(codesOf(withLines())).toEqual([])
    const unknown = withLines()
    const block = unknown.sections.at(-1)?.blocks[0] as { columns: Array<{ from: unknown }> }
    ;(block.columns[0] as { from: unknown }).from = { kind: 'field', field: 'value' }
    expect(codesOf(unknown)).toEqual(['column_field_unknown'])
  })

  it('refuses two columns with one id and a range that cannot hold', () => {
    const raw = withLines()
    const p = raw.parameters.at(-1) as typeof LINES
    p.columns.push({ id: 'amount', label: 'Ancora', kind: 'text', maxLength: 5 })
    ;(p.columns[1] as { max?: number }).max = -1
    expect(codesOf(raw).sort()).toEqual(['column_duplicate', 'parameter_range_invalid'])
  })

  it('is never a title, a filter, a single value or a default of the project', () => {
    const titled = withLines()
    ;(titled.sections.at(-1) as unknown as { title: string }).title = 'Posizioni {{lines}}'
    expect(codesOf(titled)).toContain('title_parameter_not_allowed')
    const value = withLines()
    ;(value.sections.at(-1)?.blocks[1] as { compute: unknown }).compute = {
      op: 'parameter',
      parameter: 'lines',
    }
    expect(codesOf(value)).toContain('parameter_wrong_type')
    const recipe = recipeOf(withLines())
    const settings = validateProjectRecipeSettings(recipe, {
      parameterDefaults: { lines: [] },
      templateRef: null,
      mapping: null,
      labels: {},
    })
    expect(settings.ok ? [] : settings.errors.map((e) => e.code)).toEqual(['default_not_allowed'])
  })

  it('takes rows that fit every column, and refuses any other', () => {
    const recipe = recipeOf(withLines())
    const good = rows(
      { position: '10', amount: 1200.5, due: '2026-11-30' },
      { position: '20', amount: 0, due: '2026-12-15' },
    )
    expect(checkParameterValues(recipe, { lines: good }).lines).toEqual(good)
    const refused = (v: ParameterValue) => {
      try {
        checkParameterValues(recipe, { lines: v })
        return null
      } catch (e) {
        return e instanceof DomainError ? e.code : 'other'
      }
    }
    expect(refused(rows())).toBe('recipe_rows_table_invalid')
    expect(refused(rows({ position: '10', amount: -1, due: '2026-11-30' }))).toBe(
      'recipe_rows_invalid',
    )
    expect(refused(rows({ position: '10', amount: 1, due: '30/11/2026' }))).toBe(
      'recipe_rows_invalid',
    )
    expect(refused(rows({ position: ' ', amount: 1, due: '2026-11-30' }))).toBe(
      'recipe_rows_invalid',
    )
    expect(refused(rows({ position: '10', amount: 1 }))).toBe('recipe_rows_invalid')
    expect(refused(rows({ position: '10', amount: 1, due: '2026-11-30', note: 'in più' }))).toBe(
      'recipe_rows_invalid',
    )
    const many = Array.from({ length: 4 }, (_, i) => ({
      position: String(i),
      amount: 1,
      due: '2026-11-30',
    }))
    expect(refused(rows(...many))).toBe('recipe_rows_table_invalid')
  })

  it('shows every typed cell as «indicato da te», and totals it', () => {
    const recipe = recipeOf(withLines())
    const typed = [
      { position: '10', amount: 1200.5, due: '2026-11-30' },
      { position: '20', amount: 800, due: '2026-12-15' },
    ]
    const gathered = sampleGathered() as GatheredData & {
      parameters: Record<string, ParameterValue>
      blocks: Record<string, unknown>
      notes: unknown[]
    }
    gathered.parameters.lines = { type: 'rows', rows: typed }
    const p = recipe.parameters.find((x) => x.id === 'lines')
    if (p?.type !== 'rows') throw new Error('no table')
    gathered.blocks.typed_lines = {
      status: 'read',
      rows: typedRowsRead('lines', p.columns, typed),
      totals: [],
    }
    gathered.notes.push({
      ref: { kind: 'parameter', parameterId: 'lines' },
      label: "Indicato da te: Posizioni dell'ordine",
      dataAsOf: null,
    })
    const { skeleton } = buildSkeleton(recipe, gathered)
    const section = skeleton.sections.find((s) => s.id === 'lines_section')
    const table = section?.blocks[0]
    if (table?.kind !== 'table') throw new Error('no table in the skeleton')
    expect(table.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['10', '1.200,50', '30/11/2026'],
      ['20', '800,00', '15/12/2026'],
    ])
    const note = skeleton.sourceNotes.find((n) => n.n === table.rows[0]?.cells[1]?.sources[0])
    expect(note?.label).toBe("Indicato da te: Posizioni dell'ordine")
    const total = section?.blocks[1]
    expect(total?.kind === 'value' ? total.cell.text : null).toBe('2.000,50')
  })
})

/** The table copied from the documents of another parameter, one row per position. */
function copiedLines(): ReturnType<typeof sampleRecipe> {
  const raw = withLines()
  raw.parameters.push({
    id: 'docs',
    type: 'evidence_selection',
    label: "Ordine d'acquisto",
    required: false,
    step: 3,
    multiple: false,
  })
  const lines = raw.parameters.find((x) => x.id === 'lines') as Record<string, unknown>
  lines.evidence = 'docs'
  lines.key = ['position']
  return raw
}

const DOCS: ParameterValue = { type: 'evidence_selection', evidenceIds: ['ev-order'] }
const GOOD = { position: '10', amount: 100, due: '2026-11-30' }

function refusal(raw: ReturnType<typeof sampleRecipe>, values: Record<string, ParameterValue>) {
  try {
    checkParameterValues(recipeOf(raw), values)
    return null
  } catch (e) {
    if (!(e instanceof DomainError)) throw e
    return { code: e.code, params: e.params, text: parameterErrorText(e, 'it') }
  }
}

describe('a table copied from a document', () => {
  it('names the document parameter it is copied from, which must be one', () => {
    expect(codesOf(copiedLines())).toEqual([])
    const unknown = copiedLines()
    ;(unknown.parameters.find((x) => x.id === 'lines') as Record<string, unknown>).evidence =
      'ghost'
    expect(codesOf(unknown)).toEqual(['parameter_unknown'])
    const wrong = copiedLines()
    ;(wrong.parameters.find((x) => x.id === 'lines') as Record<string, unknown>).evidence = 'note'
    expect(codesOf(wrong)).toEqual(['parameter_wrong_type'])
    const key = copiedLines()
    ;(key.parameters.find((x) => x.id === 'lines') as Record<string, unknown>).key = ['ghost']
    expect(codesOf(key)).toEqual(['key_column_unknown'])
  })

  it('asks for the document whenever the table is given, in the words of the PM', () => {
    const r = refusal(copiedLines(), { lines: rows(GOOD) })
    expect(r?.code).toBe('recipe_rows_without_evidence')
    expect(r?.text).toContain("Posizioni dell'ordine")
    expect(r?.text).toContain("Ordine d'acquisto")
    expect(refusal(copiedLines(), { lines: rows(GOOD), docs: DOCS })).toBeNull()
    // Without the table, the document alone is fine.
    expect(refusal(copiedLines(), { docs: DOCS })).toBeNull()
  })

  it('tells the PM the row and the column that do not fit', () => {
    const r = refusal(copiedLines(), {
      lines: rows(GOOD, { position: '20', amount: -5, due: '2026-12-01' }),
      docs: DOCS,
    })
    expect(r).toMatchObject({
      code: 'recipe_rows_invalid',
      params: { name: "Posizioni dell'ordine", row: 2, column: 'Importo' },
    })
    expect(r?.text).toContain('riga 2')
    expect(r?.text).toContain('Importo')
  })

  it('refuses two rows with the same key', () => {
    const r = refusal(copiedLines(), {
      lines: rows(GOOD, { ...GOOD, amount: 200 }),
      docs: DOCS,
    })
    expect(r).toMatchObject({
      code: 'recipe_rows_invalid',
      params: { row: 2, column: 'Posizione' },
    })
  })

  it('cites the rows with the documents they were copied from', () => {
    const recipe = recipeOf(copiedLines())
    const p = recipe.parameters.find((x) => x.id === 'lines')
    if (p?.type !== 'rows') throw new Error('no table')
    const [row] = typedRowsRead('lines', p.columns, [GOOD], ['ev-order'])
    expect(row?.refs.amount).toEqual({
      kind: 'parameter',
      parameterId: 'lines',
      evidenceIds: ['ev-order'],
    })
  })

  it('cites the documents only for the columns copied from them', () => {
    const raw = copiedLines()
    const lines = raw.parameters.find((x) => x.id === 'lines') as {
      columns: Array<Record<string, unknown>>
    }
    ;(lines.columns[2] as Record<string, unknown>).copied = false
    const recipe = recipeOf(raw)
    const p = recipe.parameters.find((x) => x.id === 'lines')
    if (p?.type !== 'rows') throw new Error('no table')
    const [row] = typedRowsRead('lines', p.columns, [GOOD], ['ev-order'])
    expect(row?.refs.amount).toEqual({
      kind: 'parameter',
      parameterId: 'lines',
      evidenceIds: ['ev-order'],
    })
    // A judgement of the PM («indicato da te»), not a copy of the document.
    expect(row?.refs.due).toEqual({ kind: 'parameter', parameterId: 'lines' })
  })
})
