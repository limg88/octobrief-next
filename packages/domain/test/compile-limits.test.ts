import { describe, expect, it } from 'vitest'
import { estimatedCompileCalls } from '../src/compile-limits.ts'

describe('estimatedCompileCalls', () => {
  it('the re-read estimate counts the likely splits', () => {
    // One batch of 40 chunks: its call, and up to 4 for its halves and quarters.
    expect(estimatedCompileCalls([40])).toEqual({ min: 1, max: 5 })
    // Two documents of 3 batches each: each document at most 8 calls for halves.
    expect(estimatedCompileCalls([120, 120])).toEqual({ min: 6, max: 6 + 16 })
    // A single chunk cannot be split; three chunks split once and then only the pair.
    expect(estimatedCompileCalls([1])).toEqual({ min: 1, max: 1 })
    expect(estimatedCompileCalls([3])).toEqual({ min: 1, max: 1 + 4 })
    expect(estimatedCompileCalls([2])).toEqual({ min: 1, max: 1 + 2 })
    // A document without chunks still counts one batch, never a split.
    expect(estimatedCompileCalls([0])).toEqual({ min: 1, max: 1 })
  })

  it('counts the batches of the backend in use', () => {
    // 7 transcripts of 60 chunks: 14 batches of 40, 28 of 15.
    const pilot = Array.from({ length: 7 }, () => 60)
    expect(estimatedCompileCalls(pilot).min).toBe(14)
    expect(estimatedCompileCalls(pilot, 15).min).toBe(28)
    expect(estimatedCompileCalls(pilot, 15).max).toBe(28 + 7 * 8)
  })

  it('stops at the cap of batches of a document', () => {
    expect(estimatedCompileCalls([5000]).min).toBe(25)
    expect(estimatedCompileCalls([5000], 15).min).toBe(25)
    expect(estimatedCompileCalls([5000]).max).toBe(25 + 8)
  })
})
