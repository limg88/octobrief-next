import type { Json } from '../port.ts'
import { plainDecimal } from './values.ts'
import { CATEGORY_LABEL, type DwsiCategory, type DwsiView } from './views.ts'

/** What an extraction read of one view. */
export interface ViewRows {
  view: DwsiView
  rows: Record<string, Json>[]
  sourceSyncedAt: Date | null
}

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** «Estrazione DWSI · <category> · <code> del gg/mm hh:mm», at the time in Italy. */
export function extractionTitle(category: DwsiCategory, code: string, at: Date): string {
  const parts = ROME.formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  return (
    `Estrazione DWSI · ${CATEGORY_LABEL[category]} · ${code} ` +
    `del ${part('day')}/${part('month')} ${part('hour')}:${part('minute')}`
  )
}

/**
 * A table cell: one line, the separators of the table escaped, empty for no value; a number as a
 * plain decimal, never in exponent notation.
 */
function cell(value: Json | undefined): string {
  if (value === null || value === undefined) return ''
  const s =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? plainDecimal(value)
        : JSON.stringify(value)
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
}

/**
 * The evidence of an extraction: one section per view with its rows as a table, in the order
 * of the list. It names the project and the views, and has no time in it: the same data read
 * again is the same evidence (and a project without rows still differs from another one).
 */
export function extractionDocument(
  category: DwsiCategory,
  code: string,
  views: readonly ViewRows[],
): Uint8Array {
  const lines = [`# Estrazione DWSI · ${CATEGORY_LABEL[category]} · ${code}`, '']
  for (const { view, rows } of views) {
    lines.push(`## ${view.label} (\`${view.name}\`)`, '')
    lines.push(rows.length === 1 ? '1 riga.' : `${rows.length} righe.`, '')
    if (rows.length === 0) continue
    lines.push(`| ${view.columns.map((c) => c.name).join(' | ')} |`)
    lines.push(`|${view.columns.map(() => ' --- |').join('')}`)
    for (const row of rows) {
      lines.push(`| ${view.columns.map((c) => cell(row[c.name])).join(' | ')} |`)
    }
    lines.push('')
  }
  return new TextEncoder().encode(`${lines.join('\n').trimEnd()}\n`)
}
