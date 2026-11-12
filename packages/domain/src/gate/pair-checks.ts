import type { RecipeCheck, ValueRef } from '../recipe/checks.ts'

// How the checks that compare a table with another table or with a value run on a draft.
// They read the draft through the accessors of the runner of the checks, so they read it as
// every other check does: cells as the document shows them, numbers in the notation of the
// language, «non dedotto» as nothing to judge.

/** What a check found: nothing, or the content it judged and whether it could judge it. */
export type PairOutcome =
  | { ok: true }
  | { ok: false; evaluable: boolean; content: unknown; detail: Record<string, number> }

/** How a check reads the draft. */
export interface DraftAccess {
  /** The rows of a table or a list, with the cell of a column by id; null when not in the draft. */
  rows(
    block: string,
  ): Array<{ key: string; cell: (column: string) => string | null | undefined }> | null
  /** The text of a value block or a parameter; `undefined` when absent. */
  value(ref: ValueRef): string | null | undefined
  /** The number a text shows; null for none. */
  number(text: string | null | undefined): number | null
  /** Whether two texts are the same value (as numbers when both are). */
  same(a: string, b: string): boolean
  /** Whether two numbers are the same, within the tolerance of every check. */
  sameNumber(a: number, b: number): boolean
  /** The form texts are compared in. */
  norm(text: string): string
}

const notEvaluable = (content: unknown): PairOutcome => ({
  ok: false,
  evaluable: false,
  content,
  detail: {},
})

function agreeByKey(
  check: Extract<RecipeCheck, { kind: 'agree_by_key' }>,
  draft: DraftAccess,
): PairOutcome {
  const left = draft.rows(check.left.block)
  const right = draft.rows(check.right.block)
  if (left === null || right === null) return notEvaluable(null)
  // The right side by key: a key twice on the right with two values is a disagreement too.
  const byKey = new Map<string, Array<string | null>>()
  for (const r of right) {
    const key = r.cell(check.right.key)
    const value = r.cell(check.right.value)
    if (key === undefined || value === undefined) return notEvaluable(null)
    if (key === null) continue
    const k = draft.norm(key)
    byKey.set(k, [...(byKey.get(k) ?? []), value])
  }
  const content: unknown[] = []
  let disagreements = 0
  for (const r of left) {
    const key = r.cell(check.left.key)
    const value = r.cell(check.left.value)
    if (key === undefined || value === undefined) return notEvaluable(null)
    if (key === null) continue
    const others = byKey.get(draft.norm(key))
    if (others === undefined) continue
    content.push([key, value, others])
    if (value === null || others.some((o) => o === null)) return notEvaluable(content)
    if (others.some((o) => !draft.same(value, o as string))) disagreements++
  }
  return disagreements === 0
    ? { ok: true }
    : { ok: false, evaluable: true, content, detail: { disagreements } }
}

function allEqualWhen(
  check: Extract<RecipeCheck, { kind: 'all_equal_when' }>,
  draft: DraftAccess,
): PairOutcome {
  const text = draft.value(check.when.value)
  const n = draft.number(text)
  if (n === null) return notEvaluable({ when: text ?? null })
  if (n !== check.when.equals) return { ok: true }
  const rows = draft.rows(check.column.block)
  if (rows === null) return notEvaluable({ when: text })
  const content: unknown[] = []
  let bad = 0
  for (const r of rows) {
    const cell = r.cell(check.column.column)
    if (cell === undefined) return notEvaluable({ when: text })
    content.push([r.key, cell])
    const v = draft.number(cell)
    if (v === null) return notEvaluable({ when: text, cells: content })
    if (v !== check.equals) bad++
  }
  return bad === 0
    ? { ok: true }
    : { ok: false, evaluable: true, content: { when: text, cells: content }, detail: { rows: bad } }
}

/** Sums without the float noise of decimal figures (0.1 + 0.2). */
const add = (a: number, b: number) => Math.round((a + b) * 1_000_000) / 1_000_000

function sumByKey(
  check: Extract<RecipeCheck, { kind: 'sum_by_key' }>,
  draft: DraftAccess,
): PairOutcome {
  const rows = draft.rows(check.rows.block)
  const totals = draft.rows(check.totals.block)
  if (rows === null || totals === null) return notEvaluable(null)
  // The rows summed by key: a row without its key or its figure cannot be put in a group.
  const sums = new Map<string, { key: string; sum: number }>()
  for (const r of rows) {
    const key = r.cell(check.rows.key)
    const n = draft.number(r.cell(check.rows.value))
    if (key === undefined || key === null || n === null) return notEvaluable(null)
    const k = draft.norm(key)
    const was = sums.get(k)
    sums.set(k, { key: was?.key ?? key, sum: add(was?.sum ?? 0, n) })
  }
  const content: unknown[] = []
  const declared = new Set<string>()
  let mismatches = 0
  for (const t of totals) {
    const key = t.cell(check.totals.key)
    const value = t.cell(check.totals.value)
    if (key === undefined || key === null || value === undefined) return notEvaluable(content)
    const n = draft.number(value)
    if (n === null) return notEvaluable(content)
    const k = draft.norm(key)
    declared.add(k)
    const sum = sums.get(k)?.sum ?? 0
    content.push([key, value, sum])
    if (!draft.sameNumber(sum, n)) mismatches++
  }
  // Rows of a key no subtotal declares: their figures are in no subtotal.
  for (const [k, s] of sums) {
    if (declared.has(k)) continue
    content.push([s.key, null, s.sum])
    mismatches++
  }
  return mismatches === 0
    ? { ok: true }
    : { ok: false, evaluable: true, content, detail: { mismatches } }
}

/** Runs one of the checks that compare a table with another table or with a value. */
export function runPairCheck(
  check: Extract<RecipeCheck, { kind: 'agree_by_key' | 'all_equal_when' | 'sum_by_key' }>,
  draft: DraftAccess,
): PairOutcome {
  switch (check.kind) {
    case 'agree_by_key':
      return agreeByKey(check, draft)
    case 'all_equal_when':
      return allEqualWhen(check, draft)
    case 'sum_by_key':
      return sumByKey(check, draft)
  }
}
