import { describe, expect, it } from 'vitest'
import { columnValue, plainDecimal } from '../src/dwsi/values.ts'
import type { DwsiColumn } from '../src/dwsi/views.ts'

const flag: DwsiColumn = { name: 'closed', type: 'character varying', reads: 'flag' }
const year: DwsiColumn = { name: 'anno', type: 'double precision', reads: 'year' }
const month: DwsiColumn = { name: 'mese', type: 'double precision', reads: 'month' }
const amount: DwsiColumn = { name: 'amount', type: 'double precision' }

describe('a yes/no column the warehouse writes as text', () => {
  it.each(['T', 'true', 'Yes', 'Y', '1', ' t ', 'TRUE', 'yes'])('reads «%s» as closed', (raw) => {
    expect(columnValue(flag, raw)).toBe(true)
  })

  it.each(['F', 'false', 'No', 'N', '0', ' f', 'FALSE', 'no '])('reads «%s» as open', (raw) => {
    expect(columnValue(flag, raw)).toBe(false)
  })

  it.each([null, undefined, '', ' ', 'maybe', 'chiuso', '2', 'T/F', 'yes!'])(
    'leaves %j not deduced, never guessed',
    (raw) => {
      expect(columnValue(flag, raw)).toBeNull()
    },
  )
})

describe('a year and a month the warehouse writes as floating point', () => {
  it('reads whole values as the year and the month', () => {
    expect(columnValue(year, 2026.0)).toBe(2026)
    expect(columnValue(month, 1)).toBe(1)
    expect(columnValue(month, 12.0)).toBe(12)
  })

  it.each([2026.5, Number.NaN, Number.POSITIVE_INFINITY, -2026, 0, 12_026, '2026', null])(
    'leaves the year %j not deduced, never rounded',
    (raw) => {
      expect(columnValue(year, raw)).toBeNull()
    },
  )

  it.each([0, 13, 9.5, -1, Number.NaN, Number.NEGATIVE_INFINITY, '9', null])(
    'leaves the month %j not deduced, never rounded',
    (raw) => {
      expect(columnValue(month, raw)).toBeNull()
    },
  )
})

describe('an amount the warehouse writes as floating point', () => {
  it('keeps the decimal the warehouse meant, without binary artifacts', () => {
    expect(columnValue(amount, 0.1 + 0.2)).toBe(0.3)
    expect(columnValue(amount, 98_000)).toBe(98_000)
    expect(columnValue(amount, 1234.56)).toBe(1234.56)
    expect(columnValue(amount, 45_000.1 * 3)).toBe(135_000.3)
    expect(Object.is(columnValue(amount, -0), 0)).toBe(true)
  })

  it('has no value for what is not a finite number', () => {
    expect(columnValue(amount, Number.NaN)).toBeNull()
    expect(columnValue(amount, Number.POSITIVE_INFINITY)).toBeNull()
    expect(columnValue(amount, null)).toBeNull()
  })

  it('is written as a plain decimal, never in exponent notation', () => {
    expect(plainDecimal(0.3)).toBe('0.3')
    expect(plainDecimal(98_000)).toBe('98000')
    expect(plainDecimal(1e21)).toBe('1000000000000000000000')
    expect(plainDecimal(1e-7)).toBe('0.0000001')
    expect(plainDecimal(-1234.5)).toBe('-1234.5')
    expect(plainDecimal(-0)).toBe('0')
  })
})

describe('the other columns', () => {
  it('are given as the warehouse wrote them, texts cut and normalized', () => {
    const text: DwsiColumn = { name: 'status', type: 'character varying' }
    expect(columnValue(text, 'Café')).toBe('Café')
    expect(columnValue(text, 'x'.repeat(2_000))).toHaveLength(1_000)
    expect(columnValue({ name: 'amount', type: 'numeric' }, '98000.0000')).toBe('98000.0000')
    expect(columnValue({ name: 'lineid', type: 'integer' }, 1)).toBe(1)
  })
})
