import type { Lang } from '../language/index.ts'
import type { Recipe, RecipeBlock, RecipeExclusion } from './format.ts'
import type { FieldValue } from './gathered.ts'
import { recipeText } from './messages/index.ts'

// The rows the PM asked to leave out of a block. The code leaves them out of the block and shows
// them in their own list, «Escluso su richiesta del PM», with their sources: an exclusion is a
// choice the reader sees, never a datum that silently disappears.

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>

/** The title of the list of the excluded rows, the same in every recipe. */
export function excludedListTitle(lang: Lang): string {
  return recipeText('patch', 'excluded_title', {}, lang)
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

const fold = (t: string) =>
  t.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('it')

/**
 * Whether a value names one of the excluded: as numbers when both are plain numbers without
 * leading zeros, else as texts, ignoring case, accents and spacing. A list matches by any of its
 * entries, a day by its date.
 */
export function excludedValue(value: FieldValue | undefined, values: readonly string[]): boolean {
  if (value === null || value === undefined || typeof value === 'boolean') return false
  if (Array.isArray(value)) return value.some((v) => excludedValue(v, values))
  const text = typeof value === 'object' ? (value as { day: string }).day : String(value)
  const numeric = (t: string) => PLAIN_NUMBER.test(t) && !/^-?0\d/.test(t)
  const a = text.trim()
  return values.some((wanted) => {
    const b = wanted.trim()
    if (numeric(a) && numeric(b)) return Number(a) === Number(b)
    return fold(a) === fold(b)
  })
}

/** The exclusion of a rows block, if the PM asked one. */
export function exclusionOf(recipe: Recipe, blockId: string): RecipeExclusion | undefined {
  return recipe.exclusions?.find((e) => e.block === blockId)
}

/** The exclusion whose rows a list block shows, if it is one. */
export function exclusionShownIn(recipe: Recipe, blockId: string): RecipeExclusion | undefined {
  return recipe.exclusions?.find((e) => e.shownIn === blockId)
}

/** The fields the columns of a rows block read. */
export function shownFields(block: RowsBlock): string[] {
  return block.columns.flatMap((c) => (c.from.kind === 'field' ? [c.from.field] : []))
}
