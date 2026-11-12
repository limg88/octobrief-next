import { describe, expect, it } from 'vitest'
import { sourceDeclaredDate } from '../src/document-date.ts'

const readAt = new Date('2026-11-09T10:00:00Z')
const hoursAhead = (h: number) => new Date(readAt.getTime() + h * 3_600_000)

describe('the date a source declares for an item it was read from', () => {
  it('is kept as given when it is in the past', () => {
    const past = new Date('2026-10-01T08:00:00Z')
    expect(sourceDeclaredDate(past, readAt)).toEqual(past)
  })

  it('is the read time when it is ahead by less than a day (clocks and time zones)', () => {
    expect(sourceDeclaredDate(hoursAhead(3), readAt)).toEqual(readAt)
  })

  it('is left not deduced, never «now», when it is further ahead (a due date, a plan)', () => {
    expect(sourceDeclaredDate(hoursAhead(25), readAt)).toBeNull()
    expect(sourceDeclaredDate(new Date('2027-03-31T00:00:00Z'), readAt)).toBeNull()
  })

  it('is left not deduced when it is not a date or before 1990', () => {
    expect(sourceDeclaredDate(null, readAt)).toBeNull()
    expect(sourceDeclaredDate(undefined, readAt)).toBeNull()
    expect(sourceDeclaredDate('2026-10-01', readAt)).toBeNull()
    expect(sourceDeclaredDate(new Date('not a date'), readAt)).toBeNull()
    expect(sourceDeclaredDate(new Date(0), readAt)).toBeNull()
  })
})
