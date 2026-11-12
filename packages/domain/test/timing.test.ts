import { describe, expect, it } from 'vitest'
import { growthSlope, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

// Results go here so the toy loops are not optimized away.
let sink = 0

function linearToy(n: number): () => void {
  const values = Float64Array.from({ length: n }, (_, i) => i % 7)
  return () => {
    let total = 0
    for (let i = 0; i < values.length; i++) total += values[i] ?? 0
    sink += total
  }
}

function quadraticToy(n: number): () => void {
  const values = Float64Array.from({ length: n }, (_, i) => i % 7)
  return () => {
    let total = 0
    for (let i = 0; i < values.length; i++)
      for (let j = i; j < values.length; j++) total += (values[i] ?? 0) * (values[j] ?? 0)
    sink += total
  }
}

describe('growth guard', () => {
  it(
    'passes linear work',
    () => {
      const { slope } = growthSlope((fraction) => linearToy(Math.round(2_000_000 * fraction)))
      expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
      expect(sink).toBeGreaterThan(0)
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it(
    'rejects quadratic work',
    () => {
      // The guard must be able to see quadratic work: a fit spoiled by load can read lower once, so
      // the best of three checks is asserted.
      const slopes = [0, 1, 2].map(
        () => growthSlope((fraction) => quadraticToy(Math.round(6_000 * fraction))).slope,
      )
      expect(Math.max(...slopes)).toBeGreaterThanOrEqual(MAX_GROWTH_SLOPE)
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it(
    'measures small inputs above the timer resolution',
    () => {
      // A call far below a millisecond is batched, so the fit sees real time, not timer noise.
      const { slope, largeMs } = growthSlope((fraction) => linearToy(Math.round(2_000 * fraction)))
      expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
      expect(largeMs).toBeGreaterThan(0)
      expect(largeMs).toBeLessThan(1)
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})
