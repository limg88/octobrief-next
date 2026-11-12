import { ConnectorError } from '../errors.ts'
import type { Json } from '../port.ts'
import { cutToCharacters } from '../shared/text.ts'
import { type DwsiColumn, MAX_TEXT_CHARACTERS } from './views.ts'

// A yes/no the warehouse writes as text: only these words, ignoring case and spacing.
const YES = new Set(['t', 'true', 'yes', 'y', '1'])
const NO = new Set(['f', 'false', 'no', 'n', '0'])

/** Years a period of the warehouse may fall in: anything else is not a year. */
const FIRST_YEAR = 1900
const LAST_YEAR = 2100

/**
 * Significant digits kept of a floating-point value: every decimal of up to 15 digits survives
 * the round trip through a double, so the decimal the warehouse meant comes back without the
 * binary artifacts of its sums (0.30000000000000004 is 0.3).
 */
const SIGNIFICANT_DIGITS = 15

const PLAIN = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumSignificantDigits: SIGNIFICANT_DIGITS,
})

/** A finite number as a plain decimal: a dot before the decimals, never an exponent. */
export function plainDecimal(value: number): string {
  return value === 0 ? '0' : PLAIN.format(value)
}

function flagOf(value: unknown): boolean | null {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()
  if (YES.has(word)) return true
  if (NO.has(word)) return false
  return null
}

/** A whole number in a range; anything else (a fraction, NaN, out of range) is not deduced. */
function wholeIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= min && value <= max ? value : null
}

/**
 * A value of a row as the system gives it: texts cut, a yes/no written as text read as a yes/no,
 * a year and a month written as floating point read as whole numbers, other floating-point values
 * at the precision the warehouse meant; what cannot be read is not deduced (null), never guessed.
 */
export function columnValue(column: DwsiColumn, value: unknown, relation = 'unknown'): Json {
  if (value === null || value === undefined) return null
  if (column.reads === 'flag') return flagOf(value)
  if (column.reads === 'year') return wholeIn(value, FIRST_YEAR, LAST_YEAR)
  if (column.reads === 'month') return wholeIn(value, 1, 12)
  if (typeof value === 'string') return cutToCharacters(value.normalize('NFC'), MAX_TEXT_CHARACTERS)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (column.type !== 'double precision') return value
    const meant = Number(value.toPrecision(SIGNIFICANT_DIGITS))
    return meant === 0 ? 0 : meant
  }
  if (typeof value === 'boolean') return value
  throw new ConnectorError('source_bad_response', {
    reason: `value_kind:${relation}.${column.name}`,
  })
}
