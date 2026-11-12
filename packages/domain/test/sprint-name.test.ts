import { describe, expect, it } from 'vitest'
import {
  type SourceId,
  sprintOfPeriod,
  sprintParameters,
  type WorkItem,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { deliveryRecipe } from './support/delivery-recipes.ts'
import { sampleRecipe } from './support/recipes.ts'

const SPRINT = { from: '2026-10-19', to: '2026-11-01' }

function item(id: string, sprint: string | null, at: { closed?: string; changed?: string }) {
  return {
    sourceId: 'src-ado' as SourceId,
    externalId: id,
    url: null,
    summary: null,
    type: 'Product Backlog Item',
    state: at.closed ? 'Done' : 'Committed',
    sprint,
    iteration: sprint === null ? null : `DEEM\\${sprint}`,
    area: null,
    assignee: null,
    storyPoints: null,
    priority: null,
    created: null,
    changed: at.changed ? new Date(at.changed) : at.closed ? new Date(at.closed) : null,
    closed: at.closed ? new Date(at.closed) : null,
    due: null,
    parent: null,
    tags: [],
  } satisfies WorkItem
}

describe('the sprint name of a proposal', () => {
  it("a proposed sprint takes the tracker's own sprint name", () => {
    const items = [
      item('1', '[DEEM] Sprint 28', { closed: '2026-10-21T10:00:00Z' }),
      item('2', '[DEEM] Sprint 28', { closed: '2026-10-30T10:00:00Z' }),
      // A leftover of the sprint before, closed on the first day of this one.
      item('3', '[DEEM] Sprint 27', { closed: '2026-10-19T08:00:00Z' }),
      // Outside the period, and without a sprint: neither counts.
      item('4', '[DEEM] Sprint 26', { closed: '2026-10-02T10:00:00Z' }),
      item('5', null, { closed: '2026-10-25T10:00:00Z' }),
    ]
    expect(sprintOfPeriod(items, SPRINT)).toBe('[DEEM] Sprint 28')
  })

  it('reads the changes of the period when nothing was closed in it', () => {
    const items = [item('1', 'Sprint Q4-2', { changed: '2026-10-22T10:00:00Z' })]
    expect(sprintOfPeriod(items, SPRINT)).toBe('Sprint Q4-2')
  })

  it('never makes up a name: none found, or two level, leaves the field empty', () => {
    expect(sprintOfPeriod([], SPRINT)).toBeNull()
    expect(
      sprintOfPeriod([item('1', 'Sprint 26', { closed: '2026-10-02T10:00:00Z' })], SPRINT),
    ).toBeNull()
    const level = [
      item('1', 'Sprint A', { closed: '2026-10-21T10:00:00Z' }),
      item('2', 'Sprint B', { closed: '2026-10-22T10:00:00Z' }),
    ]
    expect(sprintOfPeriod(level, SPRINT)).toBeNull()
  })

  it('the day of a change is the day in Italy', () => {
    // 23:30 UTC on the last day is already the day after in Italy.
    const late = [item('1', 'Sprint 28', { closed: '2026-11-01T23:30:00Z' })]
    expect(sprintOfPeriod(late, SPRINT)).toBeNull()
  })

  it('knows the parameters a tracker query filters its sprints by', () => {
    expect(sprintParameters(deliveryRecipe('deliverable-sprint'))).toEqual(['sprint'])
    expect(sprintParameters(recipeOf(sampleRecipe()))).toEqual([])
  })
})
