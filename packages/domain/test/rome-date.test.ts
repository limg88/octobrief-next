import { describe, expect, it } from 'vitest'
import { romeDateString, romeMidnight } from '../src/rome-time.ts'

describe('romeDateString', () => {
  it('names the Italian day of a Rome midnight, winter and summer', () => {
    expect(romeDateString(romeMidnight(2026, 1, 15))).toBe('2026-01-15')
    expect(romeDateString(romeMidnight(2026, 7, 1))).toBe('2026-07-01')
  })

  it('uses the Italian day for an instant just before midnight UTC', () => {
    expect(romeDateString(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01')
  })
})
