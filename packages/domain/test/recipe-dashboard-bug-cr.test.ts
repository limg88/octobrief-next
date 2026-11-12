import { describe, expect, it } from 'vitest'
import {
  hasClientVersion,
  type ParameterValues,
  projectClientVersion,
  type Recipe,
  runRecipeChecks,
  TRACKER_GROUP_FIELDS,
  type WorkItem,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  cellsOf,
  draftOf,
  gatherDelivery,
  project,
  valueText,
  workItemsOf,
} from './support/delivery-recipes.ts'
import { productRecipe, said } from './support/product-recipes.ts'

// The bug and CR dashboard on the synthetic «delivery» project: every count comes from the
// tracker, each item counted once and either open or closed; the open items are grouped by the
// priority the tracker records, never by a severity the tracker does not have.

const p = project()
const recipe = (): Recipe => productRecipe('dashboard-bug-cr.json')

function params(over: Partial<ParameterValues> = {}): ParameterValues {
  return {
    period: { type: 'period', from: p.tracker.sprint.start, to: p.tracker.sprint.end },
    bug_type: { type: 'text', value: 'bug' },
    cr_type: { type: 'text', value: 'cr' },
    open_states: { type: 'rows', rows: [{ state: 'In corso' }, { state: 'Da fare' }] },
    closed_states: { type: 'rows', rows: [{ state: 'Done' }] },
    stale_before: { type: 'date', day: '2026-10-20' },
    for_client: { type: 'choice', value: 'yes' },
    ...over,
  } as ParameterValues
}

function run(items: WorkItem[] = workItemsOf(p), over: Partial<ParameterValues> = {}) {
  const r = recipe()
  const gathered = gatherDelivery(r, p, params(over), items)
  const { draft } = draftOf(r, gathered, {
    summary_text: { segments: [said('Aperti e chiusi come nelle tabelle.')] },
  })
  const failed = runRecipeChecks(draft, {
    recipe: r,
    lang: 'it',
    parameters: gathered.parameterTexts,
    periods: gathered.periods,
    declaredValues: [],
  }).anomalies.map((a) => (a.ref.element === 'check' ? a.ref.check : a.code))
  return { recipe: r, gathered, draft, failed }
}

const bugsAndCrs = p.tracker.items.filter((i) => i.type === 'bug' || i.type === 'cr')

describe('the bug and CR dashboard', () => {
  it('the bug and CR dashboard counts every item once', () => {
    const { draft, failed } = run()
    expect(failed).toEqual([])
    const open = bugsAndCrs.filter((i) => i.state !== 'Done')
    expect(valueText(draft, 'perimeter_total')).toBe(String(bugsAndCrs.length))
    expect(valueText(draft, 'open_total')).toBe(String(open.length))
    expect(valueText(draft, 'closed_total')).toBe(String(bugsAndCrs.length - open.length))
    // Every item in one row of the perimeter, and in the list of the open ones or of the closed.
    const ids = cellsOf(draft, 'perimeter_items').map((r) => r[0])
    expect([...ids].sort()).toEqual(bugsAndCrs.map((i) => i.id).sort())
    const listed = [...cellsOf(draft, 'open_items'), ...cellsOf(draft, 'closed_items')].map(
      (r) => r[0],
    )
    expect([...listed].sort()).toEqual([...ids].sort())
    // Stories are not bugs nor change requests: never counted.
    expect(ids.some((id) => id?.startsWith('US-'))).toBe(false)
    // The closed in the period, and the open ones created before the threshold.
    expect(cellsOf(draft, 'closed_in_period')).toEqual([['bug', '1']])
    expect(cellsOf(draft, 'stale_items').map((r) => r[0])).toEqual(['BUG-31', 'CR-7'])
    expect(cellsOf(draft, 'stale_undated_items')).toEqual([])

    // An item the tracker gives twice is counted twice: the check says so.
    const items = workItemsOf(p)
    const twice = items.find((i) => i.externalId === 'BUG-31') as WorkItem
    expect(run([...items, twice]).failed).toEqual(
      expect.arrayContaining(['items_counted_once', 'open_listed_once']),
    )
    // An item in a state that is neither open nor closed breaks open plus closed = total.
    const odd = items.map((i) => (i.externalId === 'CR-7' ? { ...i, state: 'In revisione' } : i))
    expect(run(odd).failed).toEqual(['each_item_in_one_row', 'open_plus_closed'])
  })

  it('the bug and CR dashboard groups by priority, never by an invented severity', () => {
    const r = recipe()
    expect(TRACKER_GROUP_FIELDS).toContain('priority')
    // No block, column or computed value of the recipe is a severity.
    const named = r.sections.flatMap((s) =>
      s.blocks.flatMap((b) => [
        b.id,
        'label' in b ? b.label : '',
        'title' in b ? (b.title ?? '') : '',
        ...(b.kind === 'data_table' || b.kind === 'data_list'
          ? b.columns.flatMap((c) => [c.id, c.title, c.from.kind === 'field' ? c.from.field : ''])
          : []),
      ]),
    )
    expect(named.join(' ')).not.toMatch(/gravit|severit|severity/i)
    const grouped = r.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) =>
        (b.kind === 'data_table' || b.kind === 'data_list') && b.query.kind === 'tracker'
          ? [b.query.groupBy]
          : [],
      )
    expect(grouped).toContain('priority')

    // The groups are the priorities the tracker records, as it writes them.
    const { draft } = run()
    const open = bugsAndCrs.filter((i) => i.state !== 'Done')
    const byPriority = new Map<string, number>()
    for (const i of open) byPriority.set(i.priority, (byPriority.get(i.priority) ?? 0) + 1)
    expect(Object.fromEntries(cellsOf(draft, 'open_by_priority'))).toEqual(
      Object.fromEntries([...byPriority].map(([k, n]) => [k, String(n)])),
    )
    // An item without a priority is «non dedotto»: never given one, nor a severity.
    const unset = workItemsOf(p).map((i) =>
      i.externalId === 'BUG-31' ? { ...i, priority: null } : i,
    )
    const keys = cellsOf(run(unset).draft, 'open_by_priority').map((row) => row[0])
    expect(keys).toContain(null)
    expect(keys.filter((k) => k !== null).sort()).toEqual(['2'])

    // A summary that speaks of severity fails the bounded text, whatever its sources.
    const g = gatherDelivery(r, p, params())
    const { draft: graded } = draftOf(r, g, {
      summary_text: { segments: [said('Due bug di gravità alta restano aperti.')] },
    })
    const failed = runRecipeChecks(graded, {
      recipe: r,
      lang: 'it',
      parameters: g.parameterTexts,
      periods: g.periods,
      declaredValues: [],
    }).anomalies.map((a) => (a.ref.element === 'check' ? a.ref.check : a.code))
    expect(failed).toContain('summary_bounded')
  })

  it('splits the open and the closed items by priority', () => {
    const { draft } = run()
    const closed = bugsAndCrs.filter((i) => i.state === 'Done')
    expect(cellsOf(draft, 'closed_by_priority')).toEqual(
      [...new Set(closed.map((i) => i.priority))].map((k) => [
        k,
        String(closed.filter((i) => i.priority === k).length),
      ]),
    )
  })

  it('the bug and CR dashboard lists open items older than the threshold by their age', () => {
    const r = recipe()
    const label = r.parameters.find((x) => x.id === 'stale_before')?.label ?? ''
    expect(label).toMatch(/creati entro il/)
    const items = workItemsOf(p)
    const day = (id: string) => {
      const created = items.find((i) => i.externalId === id)?.created
      if (!created) throw new Error(`no creation date for ${id}`)
      return created.toISOString().slice(0, 10)
    }
    const aged = (d: ReturnType<typeof run>['draft']) =>
      cellsOf(d, 'stale_items').map((row) => row[0])

    // BUG-31 was changed this week but created early in October: old by its age, so listed.
    const base = run()
    expect(base.failed).toEqual([])
    expect(aged(base.draft)).toEqual(['BUG-31', 'CR-7'])
    // «Aperto dal» is the day of creation, in the list of the open items and beyond the threshold.
    const openRows = cellsOf(base.draft, 'open_items')
    const shown = (iso: string) => iso.split('-').reverse().join('/')
    expect(openRows.find((row) => row[0] === 'CR-7')?.[5]).toBe(shown(day('CR-7')))
    expect(cellsOf(base.draft, 'stale_items').find((row) => row[0] === 'CR-7')?.[3]).toBe(
      shown(day('CR-7')),
    )

    // Created on the day of the threshold counts as beyond it; created the day after does not.
    const on = run(items, { stale_before: { type: 'date', day: day('CR-7') } })
    expect(aged(on.draft)).toEqual(['CR-7'])
    const dayBefore = new Date(`${day('CR-7')}T12:00:00Z`)
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const off = run(items, {
      stale_before: { type: 'date', day: dayBefore.toISOString().slice(0, 10) },
    })
    expect(aged(off.draft)).toEqual([])

    // An item without a creation date (read before the connector read it) has no known age: it
    // is never in the list by age, its «Aperto dal» stays «non dedotto», and it is listed apart
    // as today, by its last change, only when that is on or before the threshold.
    const undated = (ids: string[]) =>
      items.map((i) => (ids.includes(i.externalId) ? { ...i, created: null } : i))
    const withoutDates = run(undated(['BUG-31', 'CR-7']))
    expect(withoutDates.failed).toEqual([])
    expect(aged(withoutDates.draft)).toEqual([])
    expect(cellsOf(withoutDates.draft, 'stale_undated_items').map((row) => row[0])).toEqual([
      'CR-7',
    ])
    expect(cellsOf(withoutDates.draft, 'open_items').find((row) => row[0] === 'CR-7')?.[5]).toBe(
      null,
    )
    // The text for the PM says how the items without a creation date are chosen.
    const notice = r.sections.flatMap((x) => x.blocks).find((b) => b.id === 'stale_notice')
    expect(notice?.kind === 'static' ? notice.text : '').toMatch(/data di creazione/)
    expect(notice?.kind === 'static' ? notice.text : '').toMatch(/ultima volta/)

    // The checks are unchanged: every item once, open plus closed equal to the total.
    const twice = items.find((i) => i.externalId === 'CR-7') as WorkItem
    expect(run([...undated(['CR-7']), { ...twice, created: null }]).failed).toEqual(
      expect.arrayContaining(['items_counted_once', 'open_listed_once']),
    )
  })

  it('keeps the perimeter internal and has a client version only on the choice of the PM', () => {
    const { recipe: r, gathered, draft } = run()
    const { version } = projectClientVersion(draft, audienceOf(r, gathered))
    expect(version.document.sections.map((s) => s.id)).toEqual([
      'summary',
      'priority',
      'trend',
      'open_list',
    ])
    expect(hasClientVersion(r, { for_client: { type: 'choice', value: 'yes' } })).toBe(true)
    expect(hasClientVersion(r, {})).toBe(false)
    expect(hasClientVersion(r, { for_client: { type: 'choice', value: 'no' } })).toBe(false)
    // Without the threshold the lists beyond it are «non dedotto», never empty.
    const { stale_before: _, ...rest } = params()
    const skipped = gatherDelivery(r, p, rest)
    expect(skipped.blocks.stale_items?.status).toBe('not_deduced')
    expect(skipped.blocks.stale_undated_items?.status).toBe('not_deduced')
  })
})
