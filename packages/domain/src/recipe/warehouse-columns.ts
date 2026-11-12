import type { Recipe } from './format.ts'

/**
 * The columns every block of a recipe reads from a view of the warehouse: what a cited row of
 * that view stands for, whichever block cites it. A text citing one block's row could quote what
 * another block reads, so a row is never worth less than all of them.
 */
export function columnsReadFrom(recipe: Recipe, view: string): string[] {
  const read = new Set<string>()
  for (const s of recipe.sections) {
    for (const b of s.blocks) {
      if (b.kind !== 'data_table' && b.kind !== 'data_list') continue
      if (b.query.kind !== 'system_rows' || b.query.view !== view) continue
      for (const c of b.columns) if (c.from.kind === 'field') read.add(c.from.field)
    }
  }
  return [...read].sort()
}
