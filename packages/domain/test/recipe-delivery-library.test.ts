import { describe, expect, it } from 'vitest'
import { effectiveCategory } from '../src/recipe/index.ts'
import { DELIVERY_SLUGS, deliveryRecipe, recipeFile } from './support/delivery-recipes.ts'

// The delivery recipes of the library, as `pnpm recipes:publish` reads them: valid, each with
// the summary of its change, and with internal data only in internal sections.

const CLIENT_SAFE = ['contract_amounts', 'invoiced_amounts', 'other', 'story_points']

describe('the delivery recipes of the library', () => {
  it.each(DELIVERY_SLUGS)('%s is a valid recipe with the summary of its change', (slug) => {
    const file = recipeFile(slug)
    expect(typeof file.changeSummary).toBe('string')
    const recipe = deliveryRecipe(slug)
    expect(recipe.slug).toBe(slug)
    expect(recipe.lang).toBe('it')
    expect(recipe.audience).toBe('client')
  })

  it.each(DELIVERY_SLUGS)(
    '%s puts costs, rates, hours and people only in internal sections',
    (slug) => {
      const recipe = deliveryRecipe(slug)
      for (const section of recipe.sections) {
        if (section.version === 'internal') continue
        for (const b of section.blocks) {
          const categories =
            b.kind === 'data_value'
              ? [effectiveCategory(recipe, b.id)]
              : b.kind === 'data_table' || b.kind === 'data_list'
                ? b.columns.map((c) => effectiveCategory(recipe, b.id, c.id))
                : []
          for (const c of categories) expect(CLIENT_SAFE).toContain(c)
        }
      }
    },
  )

  it.each(DELIVERY_SLUGS)('%s holds no name of a client or a person', (slug) => {
    const text = JSON.stringify(recipeFile(slug))
    for (const word of ['Spa', 'S.p.A.', 'Srl', 'S.r.l.', '@']) expect(text).not.toContain(word)
  })
})
