import { describe, expect, it } from 'vitest'
import {
  CHECK_CLASS,
  CHECK_KINDS,
  diffRecipes,
  type InternalDocument,
  type Recipe,
  type RecipeChecksContext,
  runRecipeChecks,
  validateRecipe,
} from '../src/recipe/index.ts'
import { internalDocument, recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'

// Two checks of the catalog that compare tables and values: two sources that disagree on the
// same item (shown with both sides, never resolved), and a state every row must reach once a
// value says so (an order requested to the end: every position at 100%).

const base = { label: 'controllo', message: 'Il controllo non torna.' }

/** The sample recipe with a second table of order lines, as the warehouse states them. */
function withWarehouseLines(checks: Array<Record<string, unknown>>) {
  const raw = sampleRecipe()
  raw.sections.push({
    id: 'warehouse',
    title: 'Righe del DWSI',
    required: false,
    version: 'both',
    removable: true,
    blocks: [
      {
        kind: 'data_table',
        id: 'dwsi_lines',
        query: { kind: 'system_rows', view: 'v_sales_order_all' },
        key: ['line'],
        columns: [
          {
            id: 'line',
            title: 'Riga',
            from: { kind: 'field', field: 'lineid' },
            category: 'other',
          },
          {
            id: 'amount',
            title: 'Importo',
            from: { kind: 'field', field: 'amount' },
            category: 'contract_amounts',
          },
        ],
      },
    ],
  })
  raw.checks = checks.map((c, i) => ({ id: `c${i + 1}`, ...base, ...c }))
  return raw
}

const cell = (text: string | null, category = 'other') => ({
  text,
  category,
  operandCategories: [category],
  sources: [1],
})

/** The sample draft with the warehouse lines given. */
function draftWith(lines: Array<[string, string | null]>): InternalDocument {
  const doc = internalDocument()
  doc.sections.push({
    id: 'warehouse',
    title: 'Righe del DWSI',
    version: 'both',
    notDeduced: false,
    blocks: [
      {
        kind: 'table',
        id: 'dwsi_lines',
        notDeduced: false,
        columns: [
          { id: 'line', title: 'Riga', category: 'other' },
          { id: 'amount', title: 'Importo', category: 'contract_amounts' },
        ],
        rows: lines.map(([line, amount]) => ({
          key: line,
          cells: [cell(line), cell(amount, 'contract_amounts')],
        })),
      },
    ],
  } as InternalDocument['sections'][number])
  return doc
}

function ctx(recipe: Recipe): RecipeChecksContext {
  return {
    recipe,
    lang: 'it',
    parameters: { period: 'ottobre 2026', request_number: '3' },
    periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
    declaredValues: [],
  }
}

const anomalies = (recipe: Recipe, doc: InternalDocument) =>
  runRecipeChecks(doc, ctx(recipe)).anomalies.map((a) => ({
    code: a.code,
    class: a.class,
    detail: a.detail,
  }))

const AGREE = {
  kind: 'agree_by_key',
  left: { block: 'positions', key: 'line', value: 'amount' },
  right: { block: 'dwsi_lines', key: 'line', value: 'amount' },
}

const CLOSED = {
  kind: 'all_equal_when',
  when: { value: { value: 'order_total' }, equals: 12000 },
  column: { block: 'positions', column: 'amount' },
  equals: 12000,
}

describe('two sources that disagree on the same item', () => {
  it('are in the closed catalog, as a check of data', () => {
    expect(CHECK_KINDS).toContain('agree_by_key')
    expect(CHECK_CLASS.agree_by_key).toBe('data')
  })

  it('pass when every key the two tables share holds the same value', () => {
    const recipe = recipeOf(withWarehouseLines([AGREE]))
    // Line 2 is only in the warehouse: nothing to compare it with.
    expect(
      anomalies(
        recipe,
        draftWith([
          ['1', '12.000,00 €'],
          ['2', '500,00 €'],
        ]),
      ),
    ).toEqual([])
  })

  it('show both sides of a disagreement, and never pick one', () => {
    const recipe = recipeOf(withWarehouseLines([AGREE]))
    const doc = draftWith([['1', '12.500,00 €']])
    const [a] = anomalies(recipe, doc)
    expect(a).toMatchObject({
      code: 'recipe_check_failed',
      class: 'data',
      detail: { kind: 'agree_by_key', disagreements: 1 },
    })
    const full = runRecipeChecks(doc, ctx(recipe)).anomalies[0]
    expect(full?.resolution).toBe('acceptance')
    // The draft itself is not changed: both figures stay where they are.
    expect(JSON.stringify(doc)).toContain('12.500,00 €')
    expect(JSON.stringify(doc)).toContain('12.000,00 €')
  })

  it('cannot be judged when a shared key has no value on one side', () => {
    const recipe = recipeOf(withWarehouseLines([AGREE]))
    expect(anomalies(recipe, draftWith([['1', null]]))).toEqual([
      expect.objectContaining({ code: 'recipe_check_not_evaluable' }),
    ])
  })

  it('names tables and columns that exist, and only tables', () => {
    const code = (check: Record<string, unknown>) => {
      const v = validateRecipe(withWarehouseLines([check]))
      return v.ok ? [] : v.errors.map((e) => e.code)
    }
    expect(code(AGREE)).toEqual([])
    expect(code({ ...AGREE, right: { block: 'dwsi_lines', key: 'line', value: 'ghost' } })).toEqual(
      ['check_target_unknown'],
    )
    expect(
      code({ ...AGREE, left: { block: 'order_total', key: 'line', value: 'amount' } }),
    ).toEqual(['check_not_applicable'])
  })

  it('compares two different tables, and only figures', () => {
    const code = (check: Record<string, unknown>) => {
      const v = validateRecipe(withWarehouseLines([check]))
      return v.ok ? [] : v.errors.map((e) => e.code)
    }
    expect(
      code({ ...AGREE, right: { block: 'positions', key: 'line', value: 'invoiced' } }),
    ).toEqual(['check_not_applicable'])
    expect(
      code({
        ...AGREE,
        left: { block: 'positions', key: 'line', value: 'date' },
        right: { block: 'dwsi_lines', key: 'line', value: 'line' },
      }),
    ).toEqual(['check_not_applicable'])
  })
})

describe('every row reaching a state once a value says so', () => {
  it('is in the closed catalog, as a check of data', () => {
    expect(CHECK_KINDS).toContain('all_equal_when')
    expect(CHECK_CLASS.all_equal_when).toBe('data')
  })

  it('asks nothing while the value does not say so', () => {
    const recipe = recipeOf(
      withWarehouseLines([{ ...CLOSED, when: { value: { value: 'order_total' }, equals: 1 } }]),
    )
    expect(anomalies(recipe, draftWith([]))).toEqual([])
  })

  it('passes when every row has the state, fails on a row that has not', () => {
    const recipe = recipeOf(withWarehouseLines([CLOSED]))
    expect(anomalies(recipe, draftWith([]))).toEqual([])
    const doc = draftWith([])
    const positions = doc.sections[0]?.blocks[0]
    if (positions?.kind !== 'table') throw new Error('fixture changed')
    positions.rows.push({
      key: '2',
      cells: positions.rows[0]?.cells.map((c, i) => ({
        ...c,
        text: i === 2 ? '11.999,99 €' : c.text,
      })) as (typeof positions.rows)[number]['cells'],
    })
    expect(anomalies(recipe, doc)).toEqual([
      {
        code: 'recipe_check_failed',
        class: 'data',
        detail: expect.objectContaining({ kind: 'all_equal_when', rows: 1 }),
      },
    ])
  })

  it('cannot be judged without the value, or with a cell that is not a number', () => {
    const recipe = recipeOf(withWarehouseLines([CLOSED]))
    const missing = draftWith([])
    const total = missing.sections[0]?.blocks[1]
    if (total?.kind !== 'value') throw new Error('fixture changed')
    total.cell.text = null
    expect(anomalies(recipe, missing)).toEqual([
      expect.objectContaining({ code: 'recipe_check_not_evaluable' }),
    ])
    const words = draftWith([])
    const positions = words.sections[0]?.blocks[0]
    if (positions?.kind !== 'table') throw new Error('fixture changed')
    ;(positions.rows[0]?.cells[2] as { text: string }).text = 'tutto'
    expect(anomalies(recipe, words)).toEqual([
      expect.objectContaining({ code: 'recipe_check_not_evaluable' }),
    ])
  })

  it('needs a number to look at and a column of a table', () => {
    const code = (check: Record<string, unknown>) => {
      const v = validateRecipe(withWarehouseLines([check]))
      return v.ok ? [] : v.errors.map((e) => e.code)
    }
    expect(code(CLOSED)).toEqual([])
    expect(code({ ...CLOSED, when: { value: { parameter: 'note' }, equals: 1 } })).toEqual([
      'check_not_applicable',
    ])
    expect(code({ ...CLOSED, column: { block: 'order_total', column: 'amount' } })).toEqual([
      'check_not_applicable',
    ])
  })

  it('tells the PM what changed in words, never in JSON', () => {
    const before = recipeOf(withWarehouseLines([]))
    const after = recipeOf(withWarehouseLines([AGREE, CLOSED]))
    const texts = diffRecipes(before, after, 'it').map((c) => c.text)
    expect(texts.join(' ')).not.toMatch(/[{}]/)
    expect(texts.length).toBeGreaterThanOrEqual(2)
  })
})
