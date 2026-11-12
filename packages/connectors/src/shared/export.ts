import type { ExternalItem } from '../port.ts'
import { uniquePeople } from './values.ts'

/** A text a spreadsheet would read as a formula or a control: shown with a leading quote. */
const FORMULA_START = /^[=+\-@\t\r]/

/** One CSV cell (RFC 4180); a text that starts like a formula is neutralized, a number is not. */
export function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const s = typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** A CSV document: a header line, one line per row, CRLF line ends. */
export function csvDocument(
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): Uint8Array {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`)
}

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** «Export <system> del gg/mm hh:mm», at the time in Italy. */
export function exportTitle(system: string, at: Date): string {
  const parts = ROME.formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return `Export ${system} del ${part('day')}/${part('month')} ${part('hour')}:${part('minute')}`
}

/**
 * The export evidence of a batch: the CSV of the items read, a backlog export (system data,
 * classified so at ingestion). Its id is the position closing the batch, and its content has no
 * time in it, so the same batch read again is the same evidence. Its perimeter and people are
 * those of the records it lists.
 */
export function backlogExport(input: {
  position: string
  title: string
  csv: Uint8Array
  asOf: Date
  records: readonly ExternalItem[]
}): ExternalItem {
  return {
    externalId: `export:${input.position}`,
    version: '1',
    title: input.title,
    mediaType: 'text/csv',
    bytes: input.csv,
    kind: 'backlog_export',
    originAt: input.asOf,
    author: null,
    url: null,
    perimeter: [...new Set(input.records.flatMap((i) => i.perimeter))].sort(),
    people: uniquePeople(input.records.flatMap((i) => i.people)),
  }
}
