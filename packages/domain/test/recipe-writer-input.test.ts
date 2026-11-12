import { describe, expect, it } from 'vitest'
import { addDays } from '../../../tools/synthetic/src/recipe-data.ts'
import {
  type ParameterValues,
  skeletonForWriter,
  type WorkItem,
  writerCountedBlocks,
} from '../src/recipe/index.ts'
import {
  deliveryRecipe,
  draftOf,
  gatherDelivery,
  project,
  workItemsOf,
} from './support/delivery-recipes.ts'

// What the writer of a slot of the Deliverable Sprint is shown on a large sprint: 200 work items
// and the timesheet of ten people over ten working days, all synthetic.

/**
 * The estimated tokens of what the writer of one slot is shown of the skeleton, with the estimator
 * of the runs (one token per byte of UTF-8: an upper bound). The first message also carries the
 * prompt, the tools and the rules of the recipe (about 4k): with this limit it stays within 13k
 * tokens estimated, against more than 80k before the tables that grow were shown by their count.
 */
const WRITER_DOCUMENT_TOKENS_MAX = 9_000

const SPRINT_ITEMS = 200

const estimatedTokens = (x: unknown) => Buffer.byteLength(JSON.stringify(x), 'utf8')

function largeSprint() {
  const p = structuredClone(project())
  const sprint = p.tracker.sprint
  const inSprint = workItemsOf(p).filter((i) => i.sprint === sprint.id)
  const items: WorkItem[] = Array.from({ length: SPRINT_ITEMS }, (_, i) => {
    const base = inSprint[i % inSprint.length] as WorkItem
    return {
      ...base,
      externalId: `GEN-${1000 + i}`,
      summary: `${base.summary} (parte ${i + 1}, con una descrizione abbastanza lunga)`,
      state: i % 3 === 0 ? 'Done' : base.state,
    }
  })
  const others = workItemsOf(p).filter((i) => i.sprint !== sprint.id)
  const template = p.dwsi.v_timesheet_all?.[0]
  if (!template) throw new Error('no timesheet row')
  p.dwsi.v_timesheet_all = Array.from({ length: 100 }, (_, n) => ({
    ...template,
    internalid: 7_000_000 + n,
    employee: `Persona Sintetica ${Math.floor(n / 10) + 1}`,
    timesheetdate: addDays(sprint.start, n % 10),
  }))
  const params: ParameterValues = {
    period: { type: 'period', from: sprint.start, to: addDays(sprint.start, 13) },
    sprint: { type: 'text', value: sprint.id },
    closed_states: { type: 'rows', rows: [{ state: 'Done' }] },
    bug_type: { type: 'text', value: 'bug' },
    cr_type: { type: 'text', value: 'cr' },
  }
  const recipe = deliveryRecipe('deliverable-sprint')
  const { skeleton } = draftOf(recipe, gatherDelivery(recipe, p, params, [...items, ...others]))
  return { recipe, skeleton }
}

interface Shown {
  sezioni: Array<{
    blocchi: Array<{
      id: string
      righe?: Array<Array<{ note: number[] }>>
      righe_non_mostrate?: number
      solo_conteggio?: boolean
      valore?: { testo: string | null; note: number[] }
    }>
  }>
  note: Array<{ n: number }>
}

const blockOf = (context: unknown, id: string) => {
  const b = (context as Shown).sezioni.flatMap((s) => s.blocchi).find((x) => x.id === id)
  if (!b) throw new Error(`no block ${id}`)
  return b
}

describe('what the writer of a slot is shown', () => {
  it('a sprint of 200 work items reaches the writer within a declared size', () => {
    const { recipe, skeleton } = largeSprint()
    const before = estimatedTokens(skeletonForWriter(skeleton, 'it').context)
    const { context } = skeletonForWriter(skeleton, 'it', undefined, writerCountedBlocks(recipe))
    expect(estimatedTokens(context)).toBeLessThan(WRITER_DOCUMENT_TOKENS_MAX)
    expect(before).toBeGreaterThan(5 * WRITER_DOCUMENT_TOKENS_MAX)
  })

  it('shows the tables that grow with the sprint by their count, the values with their notes', () => {
    const { recipe, skeleton } = largeSprint()
    expect([...writerCountedBlocks(recipe)].sort()).toEqual([
      'counted_items',
      'hours',
      'sprint_closed',
      'sprint_items',
    ])
    const { context, reads } = skeletonForWriter(
      skeleton,
      'it',
      undefined,
      writerCountedBlocks(recipe),
    )
    expect(blockOf(context, 'sprint_items')).toMatchObject({
      solo_conteggio: true,
      righe: [],
      righe_non_mostrate: SPRINT_ITEMS,
    })
    expect(blockOf(context, 'hours')).toMatchObject({ righe: [], righe_non_mostrate: 100 })
    // The counts by a field stay as rows; every value keeps its text and its notes.
    expect(blockOf(context, 'sprint_by_state').righe?.length).toBeGreaterThan(0)
    const total = blockOf(context, 'items_total').valore
    expect(total?.testo).toBe(String(SPRINT_ITEMS))
    expect(total?.note.length).toBeGreaterThan(0)
    expect(blockOf(context, 'hours_total').valore?.testo).toBe('800')
    // Only the notes of what is shown: the number of a value is still on its note.
    const shownNotes = new Set((context as Shown).note.map((n) => n.n))
    for (const n of total?.note ?? []) {
      expect(shownNotes.has(n)).toBe(true)
      expect(reads.find((r) => r.n === n)?.numbers).toContain(String(SPRINT_ITEMS))
    }
    const cited = new Set(
      (context as Shown).sezioni.flatMap((s) =>
        s.blocchi.flatMap((b) => [
          ...(b.valore?.note ?? []),
          ...(b.righe ?? []).flatMap((r) => r.flatMap((c) => c.note)),
        ]),
      ),
    )
    expect([...shownNotes].sort()).toEqual([...cited].sort())
  })
})
