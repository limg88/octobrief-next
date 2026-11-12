import { isCalendarDate, romeMidnight } from '@octobrief/domain'

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const ITALIAN_DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * The day to start reading from, as the PM writes it (`2026-01-01` or `01/01/2026`): midnight in
 * Italy of that day. Null when the text is not a day of the calendar.
 */
export function parseSince(text: string): Date | null {
  const iso = ISO_DAY.exec(text.trim())
  const italian = ITALIAN_DAY.exec(text.trim())
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : italian
      ? [Number(italian[3]), Number(italian[2]), Number(italian[1])]
      : [Number.NaN, Number.NaN, Number.NaN]
  if (!isCalendarDate(year, month, day)) return null
  return romeMidnight(year, month, day)
}
