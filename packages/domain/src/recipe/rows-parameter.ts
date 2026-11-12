import { z } from 'zod'
import { parseCalendarDay } from '../tracker.ts'
import type { DocumentSourceRef } from './document-model.ts'

// A table the PM types: rows with the columns the recipe declares (the lines of an order, the
// deliverables of a contract, the progress of each position). The PM copies them from the
// document selected with them; the model never fills them. Every cell is «indicato da te» and
// cites the parameter, like any value the PM typed.

/** Columns of a table of the PM, at most. */
export const MAX_ROWS_COLUMNS = 10
/** Rows the PM can type in one table. */
export const MAX_TYPED_ROWS = 200

/** The kinds of a column of a table of the PM. */
export const ROWS_COLUMN_KINDS = ['text', 'number', 'date'] as const
export type RowsColumnKind = (typeof ROWS_COLUMN_KINDS)[number]

/**
 * The schema of the columns of a table of the PM, made from the pieces of the format (an id, a
 * label, the longest text): no import of the format from here, so the format can import this.
 */
export function rowsColumnsSchema(parts: { id: z.ZodString; label: z.ZodString; maxText: number }) {
  const head = {
    id: parts.id,
    label: parts.label,
    /**
     * Whether the column is copied from the documents of the evidence parameter (the default);
     * false for a judgement of the PM (a percent, a grouping), cited as «indicato da te» only.
     */
    copied: z.boolean().optional(),
  }
  return z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          ...head,
          kind: z.literal('text'),
          maxLength: z.int().min(1).max(parts.maxText),
        }),
        z.strictObject({
          ...head,
          kind: z.literal('number'),
          integer: z.boolean(),
          min: z.number().optional(),
          max: z.number().optional(),
        }),
        z.strictObject({ ...head, kind: z.literal('date') }),
      ]),
    )
    .min(1)
    .max(MAX_ROWS_COLUMNS)
}

/** A column of a table of the PM. */
export type RowsColumn = { copied?: boolean | undefined } & (
  | { id: string; label: string; kind: 'text'; maxLength: number }
  | {
      id: string
      label: string
      kind: 'number'
      integer: boolean
      min?: number | undefined
      max?: number | undefined
    }
  | { id: string; label: string; kind: 'date' }
)

/** A row the PM typed: a text, a number or a day (`yyyy-mm-dd`) for each column. */
export type TypedRow = Readonly<Record<string, string | number>>

function cellFits(column: RowsColumn, value: unknown): boolean {
  switch (column.kind) {
    case 'text':
      return (
        typeof value === 'string' && value.trim() !== '' && [...value].length <= column.maxLength
      )
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!column.integer || Number.isInteger(value)) &&
        (column.min === undefined || value >= column.min) &&
        (column.max === undefined || value <= column.max)
      )
    case 'date':
      return typeof value === 'string' && parseCalendarDay(value) !== null
  }
}

/**
 * What is wrong with the rows the PM typed, or null when they fit: the table (none, or more than
 * `maxRows`), or the first row (counted from 1) and the label of the column that does not fit. A
 * row with a value for a column the table does not have is wrong as a whole (column null); a row
 * whose key repeats an earlier one is wrong at the first column of the key.
 */
export function typedRowsProblem(
  columns: readonly RowsColumn[],
  maxRows: number,
  rows: readonly TypedRow[],
  key?: readonly string[],
): { row: number | null; column: string | null } | null {
  if (rows.length === 0 || rows.length > Math.min(maxRows, MAX_TYPED_ROWS)) {
    return { row: null, column: null }
  }
  const ids = new Set(columns.map((c) => c.id))
  const seen = new Set<string>()
  for (const [i, row] of rows.entries()) {
    const at = i + 1
    if (row === null || typeof row !== 'object' || Object.keys(row).some((k) => !ids.has(k))) {
      return { row: at, column: null }
    }
    for (const c of columns) {
      if (!Object.hasOwn(row, c.id) || !cellFits(c, row[c.id])) return { row: at, column: c.label }
    }
    if (key !== undefined && key.length > 0) {
      const k = JSON.stringify(key.map((id) => String(row[id]).trim().toLowerCase()))
      if (seen.has(k)) {
        return { row: at, column: columns.find((c) => c.id === key[0])?.label ?? null }
      }
      seen.add(k)
    }
  }
  return null
}

/** Whether the rows the PM typed fit the table: `typedRowsProblem` finds nothing. */
export function typedRowsFit(
  columns: readonly RowsColumn[],
  maxRows: number,
  rows: readonly TypedRow[],
  key?: readonly string[],
): boolean {
  return typedRowsProblem(columns, maxRows, rows, key) === null
}

/**
 * The rows a block reads from a table of the PM: each field the value typed (a day for a date
 * column), each cited as the parameter: with the documents the rows were copied from for a
 * copied column, alone for a judgement of the PM.
 */
export function typedRowsRead(
  parameterId: string,
  columns: readonly RowsColumn[],
  rows: readonly TypedRow[],
  evidenceIds: readonly string[] = [],
): Array<{
  values: Record<string, string | number | { day: string }>
  refs: Record<string, DocumentSourceRef>
}> {
  const pm: DocumentSourceRef = { kind: 'parameter', parameterId }
  const copied: DocumentSourceRef =
    evidenceIds.length > 0 ? { kind: 'parameter', parameterId, evidenceIds: [...evidenceIds] } : pm
  return rows.map((row) => {
    const values: Record<string, string | number | { day: string }> = {}
    const refs: Record<string, DocumentSourceRef> = {}
    for (const c of columns) {
      const v = row[c.id] as string | number
      values[c.id] = c.kind === 'date' ? { day: v as string } : v
      refs[c.id] = c.copied === false ? pm : copied
    }
    return { values, refs }
  })
}
