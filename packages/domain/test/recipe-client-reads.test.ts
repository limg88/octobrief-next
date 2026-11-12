import { describe, expect, it } from 'vitest'
import { blocksReadForClient, type Recipe } from '../src/recipe/index.ts'
import { productRecipe } from './support/product-recipes.ts'

// The blocks a run for the client reads as the client's: those of a section of the client
// version, and those a value of that version counts or sums, even from a section of the internal
// version. A value for the client never counts what the client document may not cite.

describe('the blocks read for the client', () => {
  it('a client document never cites an internal tracker as a source of a count', () => {
    const recipe = productRecipe('deliverable-sprint.json')
    const read = blocksReadForClient(recipe)
    // The values of the overview count two lists of the internal perimeter.
    expect(read.has('counted_items')).toBe(true)
    expect(read.has('sprint_closed')).toBe(true)
    // Tables of the client version.
    expect(read.has('by_feature')).toBe(true)
    // The list of the perimeter that no value of the client version counts stays internal.
    expect(read.has('sprint_items')).toBe(false)
    // The hours are summed only by a value of the internal version.
    expect(read.has('hours')).toBe(false)
  })

  it('follows a value computed from other values, and nothing of an internal value', () => {
    const recipe = productRecipe('deliverable-sprint.json')
    const moved: Recipe = {
      ...recipe,
      sections: recipe.sections.map((s) =>
        s.id === 'overview'
          ? {
              ...s,
              blocks: s.blocks.filter((b) => b.id !== 'items_total' && b.id !== 'closed_total'),
            }
          : s.id === 'perimeter'
            ? {
                ...s,
                blocks: [
                  ...s.blocks,
                  ...(recipe.sections
                    .find((x) => x.id === 'overview')
                    ?.blocks.filter((b) => b.id === 'items_total' || b.id === 'closed_total') ??
                    []),
                ],
              }
            : s,
      ),
    }
    // The ratio of the overview reaches the client, the two totals it divides do not.
    const read = blocksReadForClient(moved)
    expect(read.has('counted_items')).toBe(true)
    expect(read.has('sprint_closed')).toBe(true)
    const internal: Recipe = {
      ...moved,
      sections: moved.sections.map((s) =>
        s.id === 'overview' ? { ...s, blocks: s.blocks.filter((b) => b.id !== 'progress') } : s,
      ),
    }
    expect(blocksReadForClient(internal).has('counted_items')).toBe(false)
  })
})
