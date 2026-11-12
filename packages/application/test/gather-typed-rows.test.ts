import { buildSkeleton, canonicalJson, type Recipe, validateRecipe } from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { gatherRecipeData } from '../src/index.ts'
import { ADO, deps, fakeStore, gatherRecipe, OCTOBER } from './support/recipe-data.ts'

// A table the PM typed (the lines of an order) is read as rows of the PM, cited as «indicato da
// te», each row written in the read log.

function withTypedLines(): Recipe {
  const base = gatherRecipe()
  const v = validateRecipe({
    ...base,
    parameters: [
      ...base.parameters,
      {
        id: 'lines',
        type: 'rows',
        label: "Posizioni dell'ordine",
        required: false,
        step: 2,
        maxRows: 10,
        columns: [
          { id: 'position', label: 'Posizione', kind: 'text', maxLength: 10 },
          { id: 'amount', label: 'Importo', kind: 'number', integer: false, min: 0 },
          { id: 'due', label: 'Scadenza', kind: 'date' },
        ],
      },
    ],
    sections: [
      ...base.sections,
      {
        id: 'typed',
        title: 'Posizioni indicate',
        required: false,
        version: 'internal',
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
        ],
      },
    ],
  })
  if (!v.ok) throw new Error(JSON.stringify(v.errors))
  return v.recipe
}

describe('a table typed by the PM in the gathering', () => {
  it('reads every typed row, cites it as the PM, and logs what was read', async () => {
    const recipe = withTypedLines()
    const lines = [
      { position: '10', amount: 1500, due: '2026-11-30' },
      { position: '20', amount: 250.5, due: '2026-12-31' },
    ]
    const { gathered, snapshot } = await gatherRecipeData(
      recipe,
      { ...OCTOBER, lines: { type: 'rows', rows: lines } },
      deps(fakeStore()),
    )
    const block = gathered.blocks.typed_lines
    if (block?.status !== 'read') throw new Error('typed lines not read')
    expect(block.rows.map((r) => r.values)).toEqual([
      { position: '10', amount: 1500, due: { day: '2026-11-30' } },
      { position: '20', amount: 250.5, due: { day: '2026-12-31' } },
    ])
    const ref = { kind: 'parameter', parameterId: 'lines' }
    expect(
      block.rows.every((r) =>
        Object.values(r.refs).every((x) => canonicalJson(x) === canonicalJson(ref)),
      ),
    ).toBe(true)
    const logged = gathered.readLog.filter((r) => canonicalJson(r.ref) === canonicalJson(ref))
    expect(logged.map((r) => r.values.amount)).toEqual([1500, 250.5])
    expect(snapshot.parameters.lines).toEqual({ type: 'rows', rows: lines })

    const { skeleton } = buildSkeleton(recipe, gathered)
    const table = skeleton.sections.flatMap((s) => s.blocks).find((b) => b.id === 'typed_lines')
    if (table?.kind !== 'table') throw new Error('no table')
    expect(table.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['10', '1.500,00', '30/11/2026'],
      ['20', '250,50', '31/12/2026'],
    ])
  })

  it('leaves the table «non dedotto» when the PM skipped it', async () => {
    const { gathered } = await gatherRecipeData(withTypedLines(), OCTOBER, deps(fakeStore()))
    expect(gathered.blocks.typed_lines).toEqual({
      status: 'not_deduced',
      reason: 'parameter_skipped',
    })
  })
})

/** The base recipe with more parameters and one more section of blocks. */
function withBlocks(parameters: unknown[], blocks: unknown[]): Recipe {
  const base = gatherRecipe()
  const v = validateRecipe({
    ...base,
    parameters: [...base.parameters, ...parameters],
    sections: [
      ...base.sections,
      { id: 'more', title: 'Altro', required: false, version: 'internal', removable: true, blocks },
    ],
  })
  if (!v.ok) throw new Error(JSON.stringify(v.errors))
  return v.recipe
}

const column = (id: string, field = id) => ({
  id,
  title: id,
  from: { kind: 'field', field },
  category: 'other',
})

describe('what the PM decides about the rows the gathering reads', () => {
  it('cites a table copied from documents with the documents chosen', async () => {
    const recipe = withBlocks(
      [
        {
          id: 'lines',
          type: 'rows',
          label: 'Righe',
          required: false,
          step: 2,
          maxRows: 5,
          evidence: 'chosen',
          columns: [{ id: 'position', label: 'Posizione', kind: 'text', maxLength: 10 }],
        },
      ],
      [
        {
          kind: 'data_table',
          id: 'typed',
          query: { kind: 'parameter', parameter: 'lines' },
          columns: [column('position')],
        },
      ],
    )
    const { gathered } = await gatherRecipeData(
      recipe,
      {
        ...OCTOBER,
        lines: { type: 'rows', rows: [{ position: '10' }] },
        chosen: { type: 'evidence_selection', evidenceIds: ['ev-contract'] },
      },
      deps(fakeStore()),
    )
    const block = gathered.blocks.typed
    if (block?.status !== 'read') throw new Error('not read')
    const ref = { kind: 'parameter', parameterId: 'lines', evidenceIds: ['ev-contract'] }
    expect(block.rows[0]?.refs.position).toEqual(ref)
    const note = gathered.notes.find((n) => canonicalJson(n.ref) === canonicalJson(ref))
    expect(note?.label).toBe('Indicato da te, dai documenti scelti in «Documenti scelti»: Righe')
  })

  it('reads the rows of the warehouse within the period, and none when the PM skipped it', async () => {
    const recipe = withBlocks(
      [{ id: 'when', type: 'period', label: 'Quando', required: false, step: 2 }],
      [
        {
          kind: 'data_table',
          id: 'dated',
          query: {
            kind: 'system_rows',
            view: 'v_sales_order_all',
            dates: { column: 'salesorderdate', period: { parameter: 'when' } },
          },
          columns: [column('order', 'salesorderid')],
        },
      ],
    )
    const september = { type: 'period', from: '2026-09-01', to: '2026-09-30' } as const
    const { gathered } = await gatherRecipeData(
      recipe,
      { ...OCTOBER, when: september },
      deps(fakeStore()),
    )
    const block = gathered.blocks.dated
    if (block?.status !== 'read') throw new Error('not read')
    expect(block.rows.map((r) => r.values.salesorderid)).toEqual(['SO-1', 'SO-1'])
    const skipped = await gatherRecipeData(recipe, OCTOBER, deps(fakeStore()))
    expect(skipped.gathered.blocks.dated).toEqual({
      status: 'not_deduced',
      reason: 'parameter_skipped',
    })
  })

  it('leaves out the excluded work items, counts the attributed ones under their new parent, and takes a list of states', async () => {
    const recipe = withBlocks(
      [
        {
          id: 'excluded',
          type: 'work_item_selection',
          label: 'Esclusi',
          required: false,
          step: 2,
          multiple: true,
        },
        {
          id: 'attributed',
          type: 'rows',
          label: 'Attribuzioni',
          required: false,
          step: 2,
          maxRows: 5,
          columns: [
            { id: 'item', label: 'Elemento', kind: 'text', maxLength: 10 },
            { id: 'feature', label: 'Feature', kind: 'text', maxLength: 10 },
          ],
        },
        {
          id: 'states',
          type: 'rows',
          label: 'Stati',
          required: false,
          step: 2,
          maxRows: 5,
          columns: [{ id: 'state', label: 'Stato', kind: 'text', maxLength: 10 }],
        },
      ],
      [
        {
          kind: 'data_table',
          id: 'by_parent',
          query: {
            kind: 'tracker',
            filter: {},
            groupBy: 'parent',
            decisions: {
              excluded: { parameter: 'excluded' },
              attributions: { parameter: 'attributed', item: 'item', parent: 'feature' },
            },
          },
          columns: [column('key'), column('count')],
        },
        {
          kind: 'data_table',
          id: 'closed_list',
          query: { kind: 'tracker', filter: { states: [{ parameter: 'states' }] } },
          columns: [column('id')],
        },
      ],
    )
    const { gathered } = await gatherRecipeData(
      recipe,
      {
        ...OCTOBER,
        excluded: { type: 'work_item_selection', items: [{ sourceId: ADO, id: '102' }] },
        attributed: { type: 'rows', rows: [{ item: '101', feature: 'F9' }] },
        states: { type: 'rows', rows: [{ state: 'Closed' }, { state: 'Chiuso' }] },
      },
      deps(fakeStore()),
    )
    const byParent = gathered.blocks.by_parent
    if (byParent?.status !== 'read') throw new Error('not read')
    expect(byParent.rows.map((r) => [r.values.key, r.values.count])).toEqual([['F9', 1]])
    const closed = gathered.blocks.closed_list
    if (closed?.status !== 'read') throw new Error('not read')
    expect(closed.rows.map((r) => r.values.id)).toEqual(['101'])
  })

  it('attributes an id two trackers share only with the tracker named, and says the PM shaped the counts', async () => {
    const store = fakeStore()
    const second = { ...(store.trackers[0] as (typeof store.trackers)[number]) }
    second.sourceId = 'src-ado-2' as typeof second.sourceId
    second.label = 'Backlog Borea'
    store.trackers.push(second)
    const twin = { ...(store.items[0] as (typeof store.items)[number]) }
    twin.sourceId = second.sourceId
    store.items.push(twin)
    const recipe = withBlocks(
      [
        {
          id: 'attributed',
          type: 'rows',
          label: 'Attribuzioni',
          required: false,
          step: 2,
          maxRows: 5,
          columns: [
            { id: 'item', label: 'Elemento', kind: 'text', maxLength: 10 },
            { id: 'feature', label: 'Feature', kind: 'text', maxLength: 10 },
            { id: 'tracker', label: 'Tracker', kind: 'text', maxLength: 40 },
          ],
        },
      ],
      [
        {
          kind: 'data_table',
          id: 'by_parent',
          query: {
            kind: 'tracker',
            filter: {},
            groupBy: 'parent',
            decisions: {
              attributions: {
                parameter: 'attributed',
                item: 'item',
                parent: 'feature',
                source: 'tracker',
              },
            },
          },
          columns: [column('key'), column('count')],
        },
      ],
    )
    const counts = async (tracker: string) => {
      const { gathered } = await gatherRecipeData(
        recipe,
        {
          ...OCTOBER,
          attributed: { type: 'rows', rows: [{ item: '101', feature: 'F9', tracker }] },
        },
        deps(store),
      )
      const b = gathered.blocks.by_parent
      if (b?.status !== 'read') throw new Error('not read')
      return {
        groups: b.rows.map((r) => [r.values.key, r.values.count]),
        notes: gathered.notes
          .filter((n) => n.ref.kind === 'work_item_counts' && n.ref.query === 'by_parent')
          .map((n) => n.label),
      }
    }
    const named = await counts('Backlog Borea')
    expect(named.groups).toContainEqual(['F9', 1])
    expect(named.notes.length).toBeGreaterThan(0)
    expect(named.notes.every((l) => l.includes('con le tue esclusioni e attribuzioni'))).toBe(true)
    // Another tracker's name attributes nothing: the shared id stays «da attribuire».
    const other = await counts('Altro tracker')
    expect(other.groups.some(([key]) => key === 'F9')).toBe(false)
  })
})
