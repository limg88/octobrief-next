import { describe, expect, it } from 'vitest'
import {
  cellDay,
  cellNumber,
  declaredCellId,
  type InternalDocument,
  type Recipe,
  type RecipeChecksContext,
  runRecipeChecks,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'
import { cleanDraft, segment, summaryText } from './support/red-team.ts'
import { growthSlope, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

const base = { label: 'controllo', message: 'Il controllo non torna.' }

function recipeWith(checks: Array<Record<string, unknown>>): Recipe {
  const raw = sampleRecipe()
  raw.checks = checks.map((c, i) => ({ id: `c${i + 1}`, ...base, ...c }))
  return recipeOf(raw)
}

function ctx(recipe: Recipe, over: Partial<RecipeChecksContext> = {}): RecipeChecksContext {
  return {
    recipe,
    lang: 'it',
    parameters: { period: 'ottobre 2026', request_number: '3' },
    periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
    declaredValues: [],
    ...over,
  }
}

type Table = Extract<InternalDocument['sections'][number]['blocks'][number], { kind: 'table' }>

function tableOf(doc: InternalDocument, id: string): Table {
  for (const s of doc.sections) {
    for (const b of s.blocks) if (b.kind === 'table' && b.id === id) return b
  }
  throw new Error(`no table ${id}`)
}

/** Adds a row to the positions of the sample draft. */
function addPosition(
  doc: InternalDocument,
  line: string,
  amount: string,
  invoiced: string,
  remaining: string,
  date = '15/10/2026',
) {
  const cell = (text: string, category: string) => ({
    text,
    category: category as 'other',
    operandCategories: [category as 'other'],
    sources: [1],
  })
  tableOf(doc, 'positions').rows.push({
    key: line,
    cells: [
      cell(line, 'other'),
      cell(`Voce ${line}`, 'other'),
      cell(amount, 'contract_amounts'),
      cell(invoiced, 'invoiced_amounts'),
      cell(remaining, 'contract_amounts'),
      cell(date, 'other'),
    ],
  })
}

const outcome = (recipe: Recipe, doc: InternalDocument, over: Partial<RecipeChecksContext> = {}) =>
  runRecipeChecks(doc, ctx(recipe, over)).anomalies.map((a) => [a.ref, a.code, a.class])

describe('checks of the recipe', () => {
  it('reads numbers and days as the PM writes them', () => {
    expect(cellNumber('12.000,50 €', 'it')).toBe(12000.5)
    expect(cellNumber('−3', 'it')).toBe(-3)
    expect(cellNumber('€ -1.200', 'it')).toBe(-1200)
    expect(cellNumber('18%', 'it')).toBe(18)
    expect(cellNumber('da 3 a 5', 'it')).toBeNull()
    expect(cellNumber(null, 'it')).toBeNull()
    expect(cellNumber('n/d', 'it')).toBeNull()
    expect(cellDay('01/10/2026', 'it')).toBe('2026-10-01')
    expect(cellDay('2026-10-31', 'it')).toBe('2026-10-31')
    expect(cellDay('1 ottobre 2026', 'it')).toBe('2026-10-01')
    expect(cellDay('31/02/2026', 'it')).toBeNull()
    expect(cellDay('fine mese', 'it')).toBeNull()
  })

  it('checks a sum against a total, with the class of the catalog', () => {
    const recipe = recipeOf()
    const doc = cleanDraft()
    expect(outcome(recipe, doc)).toEqual([])
    addPosition(doc, '2', '3.000,00 €', '0,00 €', '3.000,00 €')
    expect(outcome(recipe, doc)).toEqual([
      [{ element: 'check', check: 'positions_sum' }, 'recipe_check_failed', 'data'],
    ])
  })

  it('cannot judge a check whose values are not deduced, and says so', () => {
    const recipe = recipeOf()
    const doc = cleanDraft()
    ;(tableOf(doc, 'positions').rows[0]?.cells[2] as { text: string | null }).text = null
    const [a] = runRecipeChecks(doc, ctx(recipe)).anomalies
    expect(a).toMatchObject({
      code: 'recipe_check_not_evaluable',
      class: 'data',
      resolution: 'acceptance',
    })
  })

  it('runs every check of the catalog on the draft', () => {
    const recipe = recipeWith([
      {
        kind: 'sum_at_most',
        column: { block: 'positions', column: 'amount' },
        atMost: { value: 'order_total' },
      },
      {
        kind: 'difference_equals',
        block: 'positions',
        result: 'remaining',
        minuend: 'amount',
        subtrahend: 'invoiced',
      },
      { kind: 'values_equal', left: { value: 'feature_count' }, right: { value: 'feature_count' } },
      { kind: 'present', block: 'features' },
      {
        kind: 'member_of',
        column: { block: 'features', column: 'state' },
        in: { block: 'features', column: 'state' },
      },
      { kind: 'count_consistent', block: 'features', count: { value: 'feature_count' } },
      {
        kind: 'date_within_period',
        column: { block: 'positions', column: 'date' },
        period: 'period',
      },
      { kind: 'unique', column: { block: 'positions', column: 'line' }, againstDeclared: true },
      {
        kind: 'coverage',
        universe: { block: 'positions', column: 'line' },
        coveredBy: [{ block: 'positions', column: 'line' }],
        allowUnassigned: false,
        exclusive: true,
      },
      {
        kind: 'implies',
        block: 'features',
        condition: { column: 'state', in: ['Chiusa'] },
        consequence: { column: 'points', in: ['8', '5'] },
      },
      {
        kind: 'equals_previous',
        current: { block: 'order_total' },
        previous: { block: 'order_total' },
      },
    ])
    expect(outcome(recipe, cleanDraft())).toEqual([])

    const doc = cleanDraft()
    addPosition(doc, '1', '1.000,00 €', '0,00 €', '900,00 €', '05/11/2026')
    ;(tableOf(doc, 'features').rows[0]?.cells[2] as { text: string }).text = '3'
    const failed = runRecipeChecks(
      doc,
      ctx(recipe, {
        declaredValues: [
          {
            recipeSlug: 'sal-economico',
            sectionId: 'order',
            cellId: declaredCellId('order_total'),
            period: '2026-09-01..2026-09-30',
            value: '11.000,00 €',
            declaredAt: '2026-10-02T10:00:00.000Z',
          },
        ],
      }),
    ).anomalies
    expect(failed.map((a) => [a.ref, a.detail.kind])).toEqual([
      [{ element: 'check', check: 'c1' }, 'sum_at_most'],
      [{ element: 'check', check: 'c2' }, 'difference_equals'],
      [{ element: 'check', check: 'c7' }, 'date_within_period'],
      [{ element: 'check', check: 'c8' }, 'unique'],
      [{ element: 'check', check: 'c10' }, 'implies'],
      [{ element: 'check', check: 'c11' }, 'equals_previous'],
    ])
    expect(failed.every((a) => a.class === 'data')).toBe(true)
  })

  it('finds a value already declared to the client in another period, never in the same one', () => {
    const recipe = recipeWith([
      { kind: 'unique', column: { block: 'positions', column: 'line' }, againstDeclared: true },
    ])
    const declared = {
      recipeSlug: 'sal-economico',
      sectionId: 'order',
      cellId: declaredCellId('positions', 'line', '["1"]'),
      value: '1',
      declaredAt: '2026-10-02T10:00:00.000Z',
    }
    expect(
      outcome(recipe, cleanDraft(), {
        declaredValues: [{ ...declared, period: '2026-10-01..2026-10-31' }],
      }),
    ).toEqual([])
    expect(
      outcome(recipe, cleanDraft(), {
        declaredValues: [{ ...declared, period: '2026-09-01..2026-09-30' }],
      }),
    ).toHaveLength(1)
  })

  it('compares with the latest value declared in another period, and passes the first time', () => {
    const recipe = recipeWith([
      {
        kind: 'equals_previous',
        current: { block: 'order_total' },
        previous: { block: 'order_total' },
      },
    ])
    const d = (period: string, value: string, declaredAt: string) => ({
      recipeSlug: 'sal-economico',
      sectionId: 'order',
      cellId: declaredCellId('order_total'),
      period,
      value,
      declaredAt,
    })
    expect(outcome(recipe, cleanDraft())).toEqual([])
    expect(
      outcome(recipe, cleanDraft(), {
        declaredValues: [
          d('2026-08-01..2026-08-31', '9.000,00 €', '2026-09-02T10:00:00.000Z'),
          d('2026-09-01..2026-09-30', '12.000,00 €', '2026-10-02T10:00:00.000Z'),
          d('2026-10-01..2026-10-31', '1,00 €', '2026-11-02T10:00:00.000Z'),
        ],
      }),
    ).toEqual([])
  })

  it('compares a column with its previous values row by row', () => {
    const recipe = recipeWith([
      {
        kind: 'equals_previous',
        current: { block: 'positions', column: 'amount' },
        previous: { block: 'positions', column: 'amount' },
      },
    ])
    const prev = (value: string) => ({
      recipeSlug: 'sal-economico',
      sectionId: 'order',
      cellId: declaredCellId('positions', 'amount', '1'),
      period: '2026-09-01..2026-09-30',
      value,
      declaredAt: '2026-10-02T10:00:00.000Z',
    })
    expect(outcome(recipe, cleanDraft(), { declaredValues: [prev('12.000 €')] })).toEqual([])
    expect(outcome(recipe, cleanDraft(), { declaredValues: [prev('10.000 €')] })).toHaveLength(1)
  })

  it('checks coverage and partitions', () => {
    const recipe = (exclusive: boolean, allowUnassigned: boolean) =>
      recipeWith([
        {
          kind: 'coverage',
          universe: { block: 'positions', column: 'item' },
          coveredBy: [
            { block: 'positions', column: 'item' },
            { block: 'features', column: 'state' },
          ],
          allowUnassigned,
          exclusive,
        },
      ])
    const doc = cleanDraft()
    ;(tableOf(doc, 'features').rows[0]?.cells[1] as { text: string }).text = 'Analisi funzionale'
    expect(outcome(recipe(false, false), doc)).toEqual([])
    expect(outcome(recipe(true, false), doc)).toHaveLength(1)
    const lonely = recipeWith([
      {
        kind: 'coverage',
        universe: { block: 'positions', column: 'item' },
        coveredBy: [{ block: 'features', column: 'state' }],
        allowUnassigned: false,
        exclusive: false,
      },
    ])
    expect(outcome(lonely, cleanDraft())).toHaveLength(1)
    const allowed = recipeWith([
      {
        kind: 'coverage',
        universe: { block: 'positions', column: 'item' },
        coveredBy: [{ block: 'features', column: 'state' }],
        allowUnassigned: true,
        exclusive: false,
      },
    ])
    expect(outcome(allowed, cleanDraft())).toEqual([])
  })

  it('compares forbidden phrases as text, never as a pattern, and keeps the slot', () => {
    const recipe = recipeWith([
      {
        kind: 'bounded_text',
        slot: 'summary_text',
        forbiddenPhrases: ['(.*)', 'NESSUN problema'],
        connectorsWithoutData: false,
      },
    ])
    expect(outcome(recipe, cleanDraft())).toEqual([])
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Nessun   problema da segnalare.', [2]))
    const [a] = runRecipeChecks(doc, ctx(recipe)).anomalies
    expect(a).toMatchObject({ class: 'form', slot: 'summary_text', detail: { phrases: 1 } })
    const literal = cleanDraft()
    summaryText(literal).segments.push(segment('Vedi la nota (.*) in fondo.', [2]))
    expect(runRecipeChecks(literal, ctx(recipe)).anomalies[0]?.detail.phrases).toBe(1)
    // Dashes, soft hyphens, wide letters and lookalikes of other alphabets do not hide it.
    for (const written of [
      'Nessun-problema.',
      'Nessun – problema.',
      'Nessun prob­lema.',
      'Nessun ｐｒｏｂｌｅｍａ.',
      'Nessun prоblema.',
    ]) {
      const doc = cleanDraft()
      summaryText(doc).segments.push(segment(written, [2]))
      expect(runRecipeChecks(doc, ctx(recipe)).anomalies[0]?.detail.phrases, written).toBe(1)
    }
  })

  it('bounds the length of a slot and keeps link phrases free of data', () => {
    const recipe = recipeOf()
    const long = cleanDraft()
    summaryText(long).segments.push(segment('Testo. '.repeat(120), [2]))
    expect(runRecipeChecks(long, ctx(recipe)).anomalies[0]?.detail).toMatchObject({ tooLong: true })
    const connector = cleanDraft()
    summaryText(connector).segments.push(segment('Ci vediamo il 12 novembre.'))
    expect(runRecipeChecks(connector, ctx(recipe)).anomalies[0]?.detail).toMatchObject({
      connectors: 1,
    })
  })

  it('checks membership, uniqueness, coverage and implications in linear time', {
    timeout: TIMING_TEST_TIMEOUT_MS,
  }, () => {
    const recipe = recipeWith([
      {
        kind: 'member_of',
        column: { block: 'positions', column: 'item' },
        in: { block: 'positions', column: 'line' },
      },
      { kind: 'unique', column: { block: 'positions', column: 'item' }, againstDeclared: false },
      {
        kind: 'coverage',
        universe: { block: 'positions', column: 'line' },
        coveredBy: [{ block: 'positions', column: 'item' }],
        allowUnassigned: false,
        exclusive: true,
      },
      {
        kind: 'implies',
        block: 'positions',
        condition: { column: 'line', in: ['1'] },
        consequence: { column: 'item', in: ['1'] },
      },
    ])
    const FULL = 8_000
    const { slope } = growthSlope((fraction) => {
      const doc = cleanDraft()
      const table = tableOf(doc, 'positions')
      table.rows = []
      for (let i = 0; i < FULL * fraction; i++)
        addPosition(doc, String(i), '1,00 €', '0,00 €', '1,00 €')
      for (const row of table.rows) (row.cells[1] as { text: string }).text = row.key
      return () => runRecipeChecks(doc, ctx(recipe))
    })
    expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
  })
})
