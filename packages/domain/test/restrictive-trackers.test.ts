import { describe, expect, it } from 'vitest'
import { restrictiveTrackers } from '../src/recipe/index.ts'

describe('whose data a tracker holds at the approval', () => {
  it('a tracker is the client’s only when it was at the gathering and still is', () => {
    const stored = { a: 'client', b: 'client', c: 'internal' } as const
    expect(restrictiveTrackers(stored, undefined)).toEqual(stored)
    expect(restrictiveTrackers(stored, { a: 'client', b: 'internal', c: 'client' })).toEqual({
      a: 'client',
      b: 'internal',
      c: 'internal',
    })
    // A tracker no longer there is internal.
    expect(restrictiveTrackers(stored, {})).toEqual({ a: 'internal', b: 'internal', c: 'internal' })
  })
})
