import { describe, expect, it } from 'vitest'
import {
  applyRecipePatch,
  CHECK_CLASS,
  CHECK_KINDS,
  diffRecipes,
  type GatheredBlock,
  hasClientVersion,
  type Recipe,
  recipeLoosenings,
  runRecipeChecks,
  type TypedRow,
  typedRowsRead,
  validateRecipe,
} from '../src/recipe/index.ts'
import { checksContext, draftOf, gatheredFor, productRecipe } from './support/product-recipes.ts'

// The cost estimate (CEO): an internal document only, made of the tables the PM types (roles and
// rates, activities by phase, subtotals by phase), a declared contingency and a total. The code
// checks the sums by phase and in all, the contingency as the declared ratio and that every row
// has a role with a rate. No run, no change in words, gives it a version for the client.

const recipe = (): Recipe => productRecipe('cost-estimate.json')

interface Estimate {
  roles: TypedRow[]
  activities: TypedRow[]
  phases: TypedRow[]
  contingencyPct: number
  contingency: number
  total: number
}

/** A synthetic estimate of an assessment in four phases, consistent in every sum. */
function estimate(): Estimate {
  const roles = [
    { role: 'Analista', rate: 520 },
    { role: 'Architetto', rate: 680 },
    { role: 'Project manager', rate: 600 },
  ]
  const rate = (role: string) => roles.find((r) => r.role === role)?.rate ?? 0
  const activity = (phase: string, name: string, role: string, days: number) => ({
    phase,
    activity: name,
    role,
    days,
    cost: days * rate(role),
  })
  const activities = [
    activity('Avvio', 'Riunione di avvio e piano', 'Project manager', 2),
    activity('Analisi', 'Interviste e inventario', 'Analista', 8),
    activity('Analisi', 'Analisi dell architettura', 'Architetto', 5.5),
    activity('Raccomandazioni', 'Piano delle raccomandazioni', 'Architetto', 4),
    activity('Chiusura', 'Presentazione finale', 'Project manager', 1.5),
  ]
  const phases = ['Avvio', 'Analisi', 'Raccomandazioni', 'Chiusura'].map((phase) => {
    const mine = activities.filter((a) => a.phase === phase)
    return {
      phase,
      days: mine.reduce((n, a) => n + a.days, 0),
      cost: mine.reduce((n, a) => n + a.cost, 0),
    }
  })
  const cost = activities.reduce((n, a) => n + a.cost, 0)
  const contingency = cost / 10
  return { roles, activities, phases, contingencyPct: 10, contingency, total: cost + contingency }
}

function rowsBlock(r: Recipe, parameter: string, rows: TypedRow[]): GatheredBlock {
  const p = r.parameters.find((x) => x.id === parameter)
  if (p?.type !== 'rows') throw new Error(`${parameter} is not a table of the PM`)
  return { status: 'read', rows: typedRowsRead(p.id, p.columns, rows), totals: [] }
}

/** An estimate of one activity, with its contingency as declared and as an amount. */
function oneActivity(cost: number, contingencyPct: number, contingency: number): Estimate {
  return {
    roles: [{ role: 'Analista', rate: 500 }],
    activities: [{ phase: 'Analisi', activity: 'Analisi', role: 'Analista', days: 1, cost }],
    phases: [{ phase: 'Analisi', days: 1, cost }],
    contingencyPct,
    contingency,
    total: cost + contingency,
  }
}

/** The checks of the recipe that fail on a draft of this estimate, by id. */
function failedChecks(
  e: Estimate,
  r: Recipe = recipe(),
  change: (blocks: Record<string, GatheredBlock>) => void = () => {},
): string[] {
  const gathered = gatheredFor(
    r,
    {
      scope: { type: 'text', value: 'Assessment dei sistemi della sede centrale' },
      estimate_date: { type: 'date', day: '2026-11-05' },
      roles: { type: 'rows', rows: e.roles },
      activities: { type: 'rows', rows: e.activities },
      phases: { type: 'rows', rows: e.phases },
      contingency_pct: { type: 'number', value: e.contingencyPct },
      contingency_amount: { type: 'number', value: e.contingency },
      total: { type: 'number', value: e.total },
    },
    blocksOf(r, e, change),
  )
  const doc = draftOf(r, gathered, {})
  return runRecipeChecks(doc, checksContext(r, gathered)).anomalies.map((a) =>
    a.ref.element === 'check' ? `${a.ref.check}:${a.code}` : a.code,
  )
}

function blocksOf(
  r: Recipe,
  e: Estimate,
  change: (blocks: Record<string, GatheredBlock>) => void,
): Record<string, GatheredBlock> {
  const blocks = {
    roles: rowsBlock(r, 'roles', e.roles),
    activities: rowsBlock(r, 'activities', e.activities),
    phases: rowsBlock(r, 'phases', e.phases),
  }
  change(blocks)
  return blocks
}

describe('the cost estimate', () => {
  it('the cost estimate never has a client version', () => {
    const r = recipe()
    expect(r.audience).toBe('internal')
    expect(r.clientVersionWhen).toBeUndefined()
    expect(r.sections.every((s) => s.version === 'internal')).toBe(true)
    // Whatever the PM answers, a run has no client version.
    const answers = [{}, { for_client: { type: 'choice', value: 'yes' } }]
    for (const a of answers) expect(hasClientVersion(r, a)).toBe(false)
    // Estimates, rates and costs are declared as such, never as data for the client.
    const categories = r.sections.flatMap((s) =>
      s.blocks.flatMap((b) =>
        b.kind === 'data_table' ? b.columns.map((c) => [c.id, c.category]) : [],
      ),
    )
    expect(categories).toEqual(
      expect.arrayContaining([
        ['days', 'estimates'],
        ['rate', 'rates'],
        ['cost', 'costs'],
      ]),
    )
  })

  it('a recipe edit cannot give the cost estimate a client version', () => {
    const before = recipe()
    const section = {
      id: 'for_client',
      title: 'Sintesi per il cliente',
      required: false,
      version: 'client',
      removable: true,
      blocks: [{ kind: 'static', id: 'client_text', text: 'Sintesi della stima.' }],
    }
    const attempts = [
      { op: 'set_section_version', section: 'totals', version: 'client' },
      { op: 'set_section_version', section: 'activities', version: 'both' },
      { op: 'add_section', after: null, section },
      { op: 'add_section', after: null, section: { ...section, version: 'both' } },
    ]
    for (const op of attempts) {
      const result = applyRecipePatch(before, { operations: [op] }, 'it')
      // Refused, or a recipe that is still internal only: never a version for the client.
      if (result.ok) {
        expect(result.recipe.audience).toBe('internal')
        expect(hasClientVersion(result.recipe, {})).toBe(false)
      } else {
        expect(result.refusals.length).toBeGreaterThan(0)
      }
    }
    // Moving a section of the estimate toward the client is refused outright.
    for (const op of attempts.slice(0, 3)) {
      expect(applyRecipePatch(before, { operations: [op] }, 'it').ok).toBe(false)
    }
    // The audience is not a thing a change in words may touch.
    const widened = structuredClone(before)
    widened.audience = 'both'
    expect(recipeLoosenings(before, widened, 'it').map((x) => x.code)).toContain('recipe_changed')
  })

  it('passes its checks when sums, contingency and roles hold', () => {
    expect(failedChecks(estimate())).toEqual([])
  })

  it('checks the sums by phase against the subtotals the PM declares', () => {
    const e = estimate()
    const phases = e.phases.map((p) =>
      p.phase === 'Analisi' ? { ...p, days: Number(p.days) + 1, cost: Number(p.cost) + 100 } : p,
    )
    expect(failedChecks({ ...e, phases })).toEqual([
      'phase_days:recipe_check_failed',
      'phase_costs:recipe_check_failed',
    ])
    // A phase of the activities without its subtotal is a mismatch too.
    const missing = e.phases.filter((p) => p.phase !== 'Chiusura')
    expect(failedChecks({ ...e, phases: missing })).toEqual([
      'phase_days:recipe_check_failed',
      'phase_costs:recipe_check_failed',
    ])
  })

  it('checks the total and the contingency as the declared ratio', () => {
    const e = estimate()
    expect(failedChecks({ ...e, total: e.total + 1 })).toEqual(['total_sum:recipe_check_failed'])
    expect(failedChecks({ ...e, contingencyPct: 15 })).toEqual([
      'contingency_declared:recipe_check_failed',
    ])
  })

  it('compares the contingency with the declared percent unrounded', () => {
    // 100.400 on 1.000.000 is 10,04%: shown «10%», still not the 10% declared.
    expect(failedChecks(oneActivity(1_000_000, 10, 100_400))).toEqual([
      'contingency_declared:recipe_check_failed',
    ])
    // 72,50 on 1.000 is exactly the 7,25% declared, though shown «7,3%».
    expect(failedChecks(oneActivity(1_000, 7.25, 72.5))).toEqual([])
  })

  it('accepts a contingency typed to the cent, and nothing beyond half a cent', () => {
    // 15% of 333.333,33 is 49.999,9995: typed 50.000,00, it is the declared contingency.
    expect(failedChecks(oneActivity(333_333.33, 15, 50_000))).toEqual([])
    // A cent more is a different amount: an anomaly of data.
    expect(failedChecks(oneActivity(333_333.33, 15, 50_000.01))).toEqual([
      'contingency_declared:recipe_check_failed',
    ])
  })

  it('has no row without a role with its rate', () => {
    const e = estimate()
    const activities = e.activities.map((a, i) => (i === 0 ? { ...a, role: 'Consulente' } : a))
    expect(failedChecks({ ...e, activities })).toEqual(['every_row_has_role:recipe_check_failed'])
  })
})

describe('the sums of a table by key against declared subtotals', () => {
  it('are in the closed catalog, as a check of data', () => {
    expect(CHECK_KINDS).toContain('sum_by_key')
    expect(CHECK_CLASS.sum_by_key).toBe('data')
  })

  it('sum the rows by key whatever the case of the key, and a subtotal without rows is zero', () => {
    const e = estimate()
    const activities = e.activities.map((a) =>
      a.phase === 'Analisi' ? { ...a, phase: 'ANALISI' } : a,
    )
    expect(failedChecks({ ...e, activities })).toEqual([])
    const empty = { phase: 'Collaudo', days: 0, cost: 0 }
    expect(failedChecks({ ...e, phases: [...e.phases, empty] })).toEqual([])
    const declared = { phase: 'Collaudo', days: 2, cost: 1200 }
    expect(failedChecks({ ...e, phases: [...e.phases, declared] })).toEqual([
      'phase_days:recipe_check_failed',
      'phase_costs:recipe_check_failed',
    ])
  })

  it('cannot be judged on a row without its key, and never passes then', () => {
    const e = estimate()
    const failed = failedChecks(e, recipe(), (blocks) => {
      const b = blocks.activities
      if (b?.status !== 'read' || !b.rows[0]) throw new Error('no rows')
      const [first, ...rest] = b.rows
      blocks.activities = {
        ...b,
        rows: [{ ...first, values: { ...first.values, phase: null } }, ...rest],
      }
    })
    expect(failed).toEqual(
      expect.arrayContaining([
        'phase_days:recipe_check_not_evaluable',
        'phase_costs:recipe_check_not_evaluable',
      ]),
    )
  })

  it('tells the PM in words which columns it now compares', () => {
    const before = recipe()
    const after = structuredClone(before)
    const check = after.checks.find((c) => c.id === 'phase_days')
    if (check?.kind !== 'sum_by_key') throw new Error('no sum by key')
    check.totals = { ...check.totals, value: 'cost' }
    const changes = diffRecipes(before, after, 'it')
    expect(changes.map((c) => c.code)).toEqual(['check_scope_changed'])
    expect(changes[0]?.text).toContain('Costo della fase')
    expect(changes[0]?.text).not.toMatch(/[{}]|phase|cost\b/)
  })

  it('compare two different tables, and only figures', () => {
    const raw = structuredClone(recipe()) as unknown as Record<string, unknown> & {
      checks: Array<Record<string, unknown>>
    }
    const check = raw.checks.find((c) => c.id === 'phase_days') as Record<string, unknown>
    check.totals = { block: 'activities', key: 'phase', value: 'days' }
    const same = validateRecipe(raw)
    expect(same.ok).toBe(false)
    check.totals = { block: 'phases', key: 'phase', value: 'phase' }
    const text = validateRecipe(raw)
    expect(text.ok).toBe(false)
  })
})
