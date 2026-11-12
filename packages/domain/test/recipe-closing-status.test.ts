import { describe, expect, it } from 'vitest'
import {
  checkParameterValues,
  type DeclaredValue,
  DomainError,
  declaredCellId,
  type InternalDocument,
  type ParameterValues,
  projectClientVersion,
  type Recipe,
  runRecipeChecks,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  blockIn,
  cellsOf,
  deliveryRecipe,
  draftOf,
  EVIDENCE,
  gatherDelivery,
  project,
  TRACKER,
  valueText,
  workItemsOf,
} from './support/delivery-recipes.ts'

// The Closing Status of the library on the synthetic delivery project: the contract of the
// period with four deliverables, two delivered and two not, and the tracker of the project.

const p = project()
const PERIOD = { type: 'period', from: '2026-03-02', to: '2026-12-15' } as const
const deliverables = p.contract.deliverables

interface Over {
  delivered?: Array<Record<string, string>>
  notDelivered?: Array<Record<string, string>>
  completed?: string[]
  period?: { type: 'period'; from: string; to: string }
}

function params(over: Over = {}): ParameterValues {
  return {
    period: over.period ?? PERIOD,
    contract_doc: { type: 'evidence_selection', evidenceIds: [EVIDENCE.contract] },
    closed_states: { type: 'rows', rows: [{ state: 'Done' }, { state: 'Chiuso' }] },
    deliverables: {
      type: 'rows',
      rows: deliverables.map((d) => ({ code: d.id, title: d.title, due: d.dueDate })),
    },
    delivered: {
      type: 'rows',
      rows:
        over.delivered ??
        deliverables.filter((d) => d.delivered).map((d) => ({ code: d.id, date: d.dueDate })),
    },
    not_delivered: {
      type: 'rows',
      rows:
        over.notDelivered ??
        deliverables
          .filter((d) => !d.delivered)
          .map((d) => ({ code: d.id, reason: 'Rinviato con il cliente nel comitato di ottobre' })),
    },
    completed_items: {
      type: 'work_item_selection',
      items: (over.completed ?? ['US-201', 'US-202']).map((id) => ({ sourceId: TRACKER, id })),
    },
  }
}

function run(over: Over = {}, recipe: Recipe = deliveryRecipe('closing-status')) {
  const gathered = gatherDelivery(recipe, p, params(over))
  return { recipe, gathered, ...draftOf(recipe, gathered) }
}

function failing(recipe: Recipe, draft: InternalDocument, declaredValues: DeclaredValue[] = []) {
  return runRecipeChecks(draft, {
    recipe,
    lang: 'it',
    parameters: {},
    periods: { period: { from: PERIOD.from, to: PERIOD.to } },
    declaredValues,
  }).anomalies.map((a) => ({
    check: (a.ref as { check: string }).check,
    detail: a.detail,
  }))
}

const checkIds = (recipe: Recipe, draft: InternalDocument, declared?: DeclaredValue[]) =>
  failing(recipe, draft, declared).map((a) => a.check)

describe('the Closing Status recipe', () => {
  it('is a valid recipe for the client, with the sections of a closing in order', () => {
    const recipe = deliveryRecipe('closing-status')
    expect(recipe.audience).toBe('client')
    expect(recipe.sections.map((s) => [s.id, s.version])).toEqual([
      ['summary', 'both'],
      ['features', 'both'],
      ['contract', 'both'],
      ['scope', 'both'],
      ['team', 'internal'],
      ['risks', 'both'],
      ['verification', 'internal'],
    ])
    expect(recipe.render.formats).toEqual(['md', 'pptx'])
    expect(recipe.redTeamRules.join(' ')).toContain('«nessun blocco»')
  })

  it('builds the progress per feature from the tracker, as closed over total', () => {
    const { draft } = run()
    const total = p.tracker.items.length
    const closed = p.tracker.items.filter((i) => i.state === 'Done').length
    expect(valueText(draft, 'scope_total')).toBe(String(total))
    expect(valueText(draft, 'closed_total')).toBe(String(closed))
    const share = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(
      (closed / total) * 100,
    )
    expect(valueText(draft, 'closed_share')).toBe(`${share}%`)
    const features = cellsOf(draft, 'scope_by_feature').map((r) => r[0])
    expect(features).toEqual(expect.arrayContaining(['F1', 'F2', 'F3']))
  })

  it('the closing status counts only the increment', () => {
    // A period holding only part of the history of the tracker.
    const days = [...new Set(p.tracker.items.map((i) => i.changed))].sort()
    const period = {
      type: 'period',
      from: days[0] as string,
      to: days[Math.floor(days.length / 2)] as string,
    } as const
    const inPeriod = p.tracker.items.filter(
      (i) => i.changed >= period.from && i.changed <= period.to,
    )
    expect(inPeriod.length).toBeLessThan(p.tracker.items.length)
    const { draft } = run({ period })
    expect(valueText(draft, 'scope_total')).toBe(String(inPeriod.length))
    const closed = inPeriod.filter((i) => i.state === 'Done')
    expect(valueText(draft, 'closed_total')).toBe(String(closed.length))
    expect(cellsOf(draft, 'closed_items').map((r) => r[0])).toEqual(
      expect.arrayContaining(closed.map((i) => i.id)),
    )
    expect(cellsOf(draft, 'closed_items')).toHaveLength(closed.length)
  })

  it('the progress of the increment never goes past 100%', () => {
    const recipe = deliveryRecipe('closing-status')
    const base = workItemsOf(p)
    const first = base[0]
    if (!first) throw new Error('no item')
    // Closed in the period, changed again after it: in neither count, never closed beyond total.
    const late = {
      ...first,
      externalId: 'US-LATE',
      state: 'Done',
      closed: new Date('2026-06-10T10:00:00.000Z'),
      changed: new Date('2026-07-20T10:00:00.000Z'),
    }
    const period = { type: 'period', from: '2026-06-01', to: '2026-06-30' } as const
    const { draft } = draftOf(
      recipe,
      gatherDelivery(recipe, p, { ...params(), period }, [...base, late]),
    )
    const total = Number(valueText(draft, 'scope_total') ?? '0')
    const closed = Number(valueText(draft, 'closed_total') ?? '0')
    expect(closed).toBeLessThanOrEqual(total)
    // The check stands guard all the same.
    expect(recipe.checks.map((c) => c.id)).toContain('closed_within_scope')
  })

  it('counts only the iteration of the increment, when the PM gives it', () => {
    // The tracker writes the sprint by its id: the last part of the iteration path.
    const sprint = p.tracker.sprint.id
    const recipe = deliveryRecipe('closing-status')
    const gathered = gatherDelivery(recipe, p, {
      ...params(),
      pi_iteration: { type: 'text', value: `${p.projectName}\\${sprint}` },
    })
    const { draft } = draftOf(recipe, gathered)
    const inIteration = p.tracker.items.filter(
      (i) => i.sprint === sprint && i.changed >= PERIOD.from && i.changed <= PERIOD.to,
    )
    expect(inIteration.length).toBeGreaterThan(0)
    expect(inIteration.length).toBeLessThan(
      p.tracker.items.filter((i) => i.changed >= PERIOD.from && i.changed <= PERIOD.to).length,
    )
    expect(valueText(draft, 'scope_total')).toBe(String(inIteration.length))
  })

  it('lists every contract deliverable', () => {
    const { draft, recipe } = run()
    expect(cellsOf(draft, 'contract_deliverables').map((r) => r[0])).toEqual(
      deliverables.map((d) => d.id),
    )
    expect(checkIds(recipe, draft)).toEqual([])
    // One forgotten: neither delivered nor not delivered.
    const forgotten = run({
      notDelivered: [{ code: 'DEL-3', reason: 'Rinviato con il cliente' }],
    })
    expect(failing(forgotten.recipe, forgotten.draft)).toContainEqual({
      check: 'deliverables_covered',
      detail: expect.objectContaining({ uncovered: 1, overlapping: 0 }),
    })
    // One in both lists.
    const twice = run({
      delivered: [
        { code: 'DEL-1', date: '2026-04-30' },
        { code: 'DEL-2', date: '2026-09-30' },
        { code: 'DEL-3', date: '2026-10-30' },
      ],
    })
    expect(failing(twice.recipe, twice.draft)).toContainEqual({
      check: 'deliverables_covered',
      detail: expect.objectContaining({ overlapping: 1 }),
    })
  })

  it('refuses a deliverable outside the contract', () => {
    const { recipe, draft } = run({
      delivered: [
        { code: 'DEL-1', date: '2026-04-30' },
        { code: 'DEL-2', date: '2026-09-30' },
        { code: 'DEL-9', date: '2026-10-01' },
      ],
    })
    expect(checkIds(recipe, draft)).toContain('delivered_in_contract')
  })

  it('refuses a delivery dated outside the period', () => {
    const { recipe, draft } = run({
      delivered: [
        { code: 'DEL-1', date: '2026-01-15' },
        { code: 'DEL-2', date: '2026-09-30' },
      ],
    })
    expect(checkIds(recipe, draft)).toContain('delivered_in_period')
  })

  it('says «completato» only of what the tracker closed', () => {
    const open = p.truth.activeBlocker.itemId
    const { recipe, draft } = run({ completed: ['US-201', open] })
    expect(cellsOf(draft, 'completed_items').find((r) => r[0] === open)?.[2]).toBe('In corso')
    expect(checkIds(recipe, draft)).toEqual(['completed_only_if_closed'])
  })

  it('keeps the base of the progress as declared to the client, unless the PM says why', () => {
    const { recipe, draft } = run()
    const declared = (value: string): DeclaredValue => ({
      recipeSlug: 'closing-status',
      sectionId: 'features',
      cellId: declaredCellId('scope_total'),
      period: '2026-01-01..2026-03-01',
      value,
      declaredAt: '2026-03-02T09:00:00.000Z',
    })
    expect(checkIds(recipe, draft, [declared(String(p.tracker.items.length))])).toEqual([])
    expect(checkIds(recipe, draft, [declared('7')])).toEqual(['scope_base_as_declared'])
  })

  it('never lets the model extract the contract deliverables: the PM copies them, citing the contract', () => {
    const { draft } = run()
    const table = blockIn(draft, 'contract_deliverables')
    if (table.kind !== 'table') throw new Error('no deliverables')
    const cited = new Set(table.rows.flatMap((r) => r.cells.flatMap((c) => c.sources)))
    expect(cited.size).toBe(1)
    const note = draft.sourceNotes.find((n) => cited.has(n.n))
    expect(note && 'ref' in note ? note.ref : null).toEqual({
      kind: 'parameter',
      parameterId: 'deliverables',
      evidenceIds: [EVIDENCE.contract],
    })
    // Without the contract chosen, the table is refused before anything is read.
    const recipe = deliveryRecipe('closing-status')
    const { contract_doc: _, ...withoutContract } = params()
    expect(() => gatherDelivery(recipe, p, checkParameterValues(recipe, withoutContract))).toThrow(
      DomainError,
    )
  })

  it('tells the reviewer to say «completato» only of what the PM presents as completed', () => {
    const recipe = deliveryRecipe('closing-status')
    expect(recipe.redTeamRules.join(' ')).toMatch(/«completat[oi]»/)
  })

  it('sums the hours of the team within the period only', () => {
    const period = { type: 'period', from: '2026-10-27', to: '2026-12-15' } as const
    const { draft } = run({ period })
    const inPeriod = (p.dwsi.v_timesheet_all ?? []).filter(
      (r) => String(r.timesheetdate) >= period.from && String(r.timesheetdate) <= period.to,
    )
    expect(inPeriod.length).toBeLessThan((p.dwsi.v_timesheet_all ?? []).length)
    expect(cellsOf(draft, 'hours')).toHaveLength(inPeriod.length)
    expect(valueText(draft, 'hours_total')).toBe(
      String(inPeriod.reduce((n, r) => n + Number(r.duration), 0)),
    )
  })

  it('keeps the team effort out of the client version', () => {
    const { recipe, gathered, draft } = run()
    expect(blockIn(draft, 'hours').kind).toBe('table')
    const { version } = projectClientVersion(draft, audienceOf(recipe, gathered))
    expect(version.document.sections.map((s) => s.id)).not.toContain('team')
    expect(version.document.sections.map((s) => s.id)).not.toContain('verification')
  })
})
