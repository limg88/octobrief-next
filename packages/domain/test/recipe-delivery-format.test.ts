import { describe, expect, it } from 'vitest'
import {
  type DeclaredValue,
  declaredCellId,
  recipeLoosenings,
  runRecipeChecks,
  validateRecipe,
} from '../src/recipe/index.ts'
import { internalDocument, recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'

// What the delivery recipes need of the format: rows of the warehouse within the period of the
// run, decisions of the PM applied to what the tracker counts, a list of states the PM gives,
// and a sum that counts what was already declared to the client. Each is validated, and taking
// it away is a loosening a change in words may not make.

type Raw = ReturnType<typeof sampleRecipe>

const codesOf = (raw: unknown) => {
  const v = validateRecipe(raw)
  return v.ok ? [] : v.errors.map((e) => e.code)
}

/** The sample with its hours read within the period of the run. */
function hoursInPeriod(column = 'timesheetdate', parameter = 'period'): Raw {
  const raw = sampleRecipe()
  const hours = raw.sections.find((s) => s.id === 'team')?.blocks[0] as {
    query: Record<string, unknown>
  }
  hours.query.dates = { column, period: { parameter } }
  return raw
}

/** The sample with the decisions of the PM on its features: exclusions and attributions. */
function withDecisions(): Raw {
  const raw = sampleRecipe()
  raw.parameters.push(
    {
      id: 'excluded',
      type: 'work_item_selection',
      label: 'Esclusi',
      required: false,
      step: 3,
      multiple: true,
    },
    {
      id: 'attributed',
      type: 'rows',
      label: 'Attribuzioni',
      required: false,
      step: 3,
      maxRows: 10,
      columns: [
        { id: 'item', label: 'Elemento', kind: 'text', maxLength: 40 },
        { id: 'feature', label: 'Feature', kind: 'text', maxLength: 40 },
      ],
    },
    {
      id: 'closed_states',
      type: 'rows',
      label: 'Stati di chiusura',
      required: false,
      step: 3,
      maxRows: 5,
      columns: [{ id: 'state', label: 'Stato', kind: 'text', maxLength: 40 }],
    },
  )
  const features = raw.sections.find((s) => s.id === 'progress')?.blocks[0] as {
    query: { filter: Record<string, unknown>; decisions?: unknown }
  }
  features.query.filter.states = [{ parameter: 'closed_states' }]
  features.query.decisions = {
    excluded: { parameter: 'excluded' },
    attributions: { parameter: 'attributed', item: 'item', parent: 'feature' },
  }
  return raw
}

describe('rows of the warehouse within the period of the run', () => {
  it('are read by a date column of the view and a period parameter', () => {
    expect(codesOf(hoursInPeriod())).toEqual([])
    expect(codesOf(hoursInPeriod('employee'))).toEqual(['system_dates_column_invalid'])
    expect(codesOf(hoursInPeriod('timesheetdate', 'request_number'))).toEqual([
      'parameter_wrong_type',
    ])
  })

  it('cannot lose their period in a change in words', () => {
    const before = recipeOf(hoursInPeriod())
    expect(recipeLoosenings(before, recipeOf(sampleRecipe()), 'it')).not.toEqual([])
  })
})

describe('the decisions of the PM on what the tracker counts', () => {
  it('name an exclusion of work items and a table of attributions with its columns', () => {
    expect(codesOf(withDecisions())).toEqual([])
    const wrong = withDecisions()
    const q = (
      (wrong.sections.find((s) => s.id === 'progress') as Raw['sections'][number]).blocks[0] as {
        query: { decisions: { excluded: unknown; attributions: Record<string, unknown> } }
      }
    ).query
    q.decisions.excluded = { parameter: 'note' }
    q.decisions.attributions.parent = 'ghost'
    expect(codesOf(wrong).sort()).toEqual(['column_field_unknown', 'parameter_wrong_type'])
  })

  it('may name the tracker of each attribution by a text column of the table', () => {
    const raw = withDecisions()
    const attributed = raw.parameters.find((x) => x.id === 'attributed') as {
      columns: Array<Record<string, unknown>>
    }
    attributed.columns.push({ id: 'tracker', label: 'Tracker', kind: 'text', maxLength: 60 })
    const q = (
      (raw.sections.find((s) => s.id === 'progress') as Raw['sections'][number]).blocks[0] as {
        query: { decisions: { attributions: Record<string, unknown> } }
      }
    ).query
    q.decisions.attributions.source = 'tracker'
    expect(codesOf(raw)).toEqual([])
    q.decisions.attributions.source = 'ghost'
    expect(codesOf(raw)).toEqual(['column_field_unknown'])
  })

  it('take a list of states from a table of one text column, and nothing else', () => {
    const two = withDecisions()
    const states = two.parameters.find((x) => x.id === 'closed_states') as {
      columns: Array<Record<string, unknown>>
    }
    states.columns.push({ id: 'other', label: 'Altro', kind: 'text', maxLength: 5 })
    expect(codesOf(two)).toEqual(['parameter_wrong_type'])
  })

  it('cannot be dropped in a change in words', () => {
    const before = recipeOf(withDecisions())
    const after = withDecisions()
    const q = (
      (after.sections.find((s) => s.id === 'progress') as Raw['sections'][number]).blocks[0] as {
        query: Record<string, unknown>
      }
    ).query
    delete q.decisions
    expect(recipeLoosenings(before, recipeOf(after), 'it')).not.toEqual([])
  })
})

describe('a sum that counts what was already declared to the client', () => {
  const recipe = (withDeclared: boolean) => {
    const raw = sampleRecipe()
    raw.checks = [
      {
        id: 'within',
        kind: 'sum_at_most',
        label: 'entro il totale',
        message: 'Si supera il totale.',
        column: { block: 'positions', column: 'amount' },
        atMost: { value: 'order_total' },
        withDeclared,
      },
    ]
    return recipeOf(raw)
  }
  const declared = (period: string, row: string, value: string, at: string): DeclaredValue => ({
    recipeSlug: 'sal-economico',
    sectionId: 'order',
    cellId: declaredCellId('positions', 'amount', row),
    period,
    value,
    declaredAt: at,
  })
  const failing = (withDeclared: boolean, values: DeclaredValue[]) =>
    runRecipeChecks(internalDocument(), {
      recipe: recipe(withDeclared),
      lang: 'it',
      parameters: { period: 'ottobre 2026' },
      periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
      declaredValues: values,
    }).anomalies.length

  it("adds the values declared before, each row as approved last, but never this run's own rows", () => {
    // The sample's own position equals the total: anything declared before goes beyond it.
    expect(failing(true, [])).toBe(0)
    const before = [declared('2026-09-01..2026-09-30', '["7"]', '1,00 €', '2026-09-30T10:00:00Z')]
    expect(failing(false, before)).toBe(0)
    expect(failing(true, before)).toBe(1)
    // A row of this run declared before (the same request issued again) is never counted twice.
    expect(
      failing(true, [
        declared('2026-10-01..2026-10-31', '1', '12.000,00 €', '2026-10-31T10:00:00Z'),
      ]),
    ).toBe(0)
    // Another request of the same period, approved with another run, counts.
    expect(
      failing(true, [declared('2026-10-01..2026-10-31', '2', '1,00 €', '2026-10-15T10:00:00Z')]),
    ).toBe(1)
    // An approval that replaced an earlier one of the same period counts once, as approved last.
    const again = [
      declared('2026-09-01..2026-09-30', '["7"]', '1,00 €', '2026-09-30T10:00:00Z'),
      declared('2026-09-01..2026-09-30', '["7"]', '0,00 €', '2026-09-30T12:00:00Z'),
    ]
    expect(failing(true, again)).toBe(0)
  })

  it('cannot stop counting them in a change in words', () => {
    expect(recipeLoosenings(recipe(true), recipe(false), 'it')).not.toEqual([])
  })
})
