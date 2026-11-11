// Calendar dates in this product are days in Italy: stored as midnight Europe/Rome.

const ROME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

/** Offset of Europe/Rome from UTC at an instant, in milliseconds. */
function romeOffsetMs(at: Date): number {
  const p: Record<string, number> = {}
  for (const part of ROME.formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(
    p.year as number,
    (p.month as number) - 1,
    p.day as number,
    p.hour as number,
    p.minute as number,
    p.second as number,
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Whether year, month (1-12) and day name a real calendar day. */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  if (![year, month, day].every(Number.isInteger)) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  probe.setUTCFullYear(year) // years 0-99 would otherwise map to 1900-1999
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/**
 * Midnight Europe/Rome of a calendar day (already validated). Midnight is never inside a clock
 * change in Rome (they happen at 02:00/03:00), so one refinement of the offset is exact.
 */
export function romeMidnight(year: number, month: number, day: number): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day)
  const firstGuess = wallAsUtc - romeOffsetMs(new Date(wallAsUtc))
  return new Date(wallAsUtc - romeOffsetMs(new Date(firstGuess)))
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The calendar day (`yyyy-mm-dd`) of an instant in Europe/Rome. */
export function romeDateString(at: Date): string {
  const p: Record<string, string> = {}
  for (const part of DAY.formatToParts(at)) p[part.type] = part.value
  return [p.year, p.month, p.day].join('-')
}
