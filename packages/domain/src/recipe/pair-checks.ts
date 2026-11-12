import { z } from 'zod'

// Checks of the closed catalog that compare a table with another table or with a value:
// - `agree_by_key`: where two tables hold the same key (an invoice in the document and in the
//   data warehouse), a column of each holds the same value; a disagreement is shown with both
//   sides and never resolved;
// - `all_equal_when`: once a value says so (nothing left to request on an order), every cell of a
//   column holds one number (every position at 100%);
// - `sum_by_key`: the rows of a table summed by a key column (the activities of an estimate by
//   phase) give, for every key, the value another table declares for it (the subtotal of the
//   phase); a key without its subtotal, or a subtotal without rows, is a mismatch.
// The schemas are made from the pieces of the catalog, so the catalog can include them without
// this file importing it.

export const PAIR_CHECK_KINDS = ['agree_by_key', 'all_equal_when', 'sum_by_key'] as const
export type PairCheckKind = (typeof PAIR_CHECK_KINDS)[number]

/** The schemas of these checks, from the pieces of the catalog. */
export function pairCheckSchemas<
  Base extends z.core.$ZodLooseShape,
  Id extends z.ZodType<string>,
  Col extends z.ZodType,
  Val extends z.ZodType,
>(parts: { base: Base; id: Id; columnRef: Col; valueRef: Val }) {
  const side = z.strictObject({ block: parts.id, key: parts.id, value: parts.id })
  return [
    z.strictObject({
      ...parts.base,
      kind: z.literal('agree_by_key'),
      left: side,
      right: side,
    }),
    z.strictObject({
      ...parts.base,
      kind: z.literal('all_equal_when'),
      when: z.strictObject({ value: parts.valueRef, equals: z.number() }),
      column: parts.columnRef,
      equals: z.number(),
    }),
    z.strictObject({
      ...parts.base,
      kind: z.literal('sum_by_key'),
      /** The rows summed: their key column and the column of the figures. */
      rows: side,
      /** The declared subtotals: one row per key, with the figure the sum must give. */
      totals: side,
    }),
  ] as const
}
