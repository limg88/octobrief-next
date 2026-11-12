/** Generous ceiling that only guards against a hang; never the real assertion. */
export const HANG_GUARD_MS = 10_000
/** Per-test timeout for tests that time many samples; a hang guard, not a speed claim. */
export const TIMING_TEST_TIMEOUT_MS = 120_000
/**
 * Highest allowed slope of log(time) over log(size): linear work is about 1, quadratic about 2.
 * The limit sits halfway, so scheduler noise cannot cross it but quadratic work does.
 */
export const MAX_GROWTH_SLOPE = 1.5

/** Input sizes, as fractions of the full input, fitted together: an 8x span. */
export const GROWTH_FRACTIONS = [1 / 8, 1 / 4, 1 / 2, 1] as const

/** Timing samples per size; the minimum is kept, because load only ever adds time. */
const SAMPLES = 5
/**
 * Shortest batch that is timed, in ms of CPU. A call faster than this is repeated within one
 * sample, so every point of the fit sits well above the timer resolution.
 */
const MIN_BATCH_MS = 5
/** Upper bound on the repetitions of one call per sample. */
const MAX_REPEATS = 1 << 16

/** CPU time of the process, in ms: time spent descheduled under load is not counted. */
function cpuMs(fn: () => void, repeats: number): number {
  const start = process.cpuUsage()
  for (let i = 0; i < repeats; i++) fn()
  const used = process.cpuUsage(start)
  return (used.user + used.system) / 1000
}

/**
 * CPU time of one call, in ms: the fastest of `SAMPLES` batches, after a warm-up that also picks
 * how many calls one batch needs to last at least `MIN_BATCH_MS`.
 */
export function minTime(fn: () => void): number {
  let repeats = 1
  while (cpuMs(fn, repeats) < MIN_BATCH_MS && repeats < MAX_REPEATS) repeats *= 2
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < SAMPLES; i++) best = Math.min(best, cpuMs(fn, repeats) / repeats)
  return best
}

/** Least-squares slope of y over x. */
function slopeOf(points: Array<[number, number]>): number {
  const n = points.length
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n
  let num = 0
  let den = 0
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY)
    den += (x - meanX) ** 2
  }
  return num / den
}

/**
 * How time grows with the input: `work(fraction)` prepares the input at that fraction of the full
 * size and returns the call to time. The result is the log-log slope fitted over
 * `GROWTH_FRACTIONS` (about 1 for linear work, 2 for quadratic) and the time of one call at full
 * size, for a hang guard.
 */
export function growthSlope(work: (fraction: number) => () => void): {
  slope: number
  largeMs: number
} {
  // Noise (coverage instrumentation, a loaded runner) can push one fit over the limit: such a fit
  // is measured twice more and the median of the three decides.
  const first = fitOnce(work)
  if (first.slope < MAX_GROWTH_SLOPE) return first
  // The median of three fits: one noisy fit, up or down, cannot decide alone. Keeping the lowest
  // would let one fit spoiled by load make quadratic work look linear.
  const fits = [first, fitOnce(work), fitOnce(work)].sort((a, b) => a.slope - b.slope)
  return fits[1] as { slope: number; largeMs: number }
}

function fitOnce(work: (fraction: number) => () => void): { slope: number; largeMs: number } {
  const points: Array<[number, number]> = []
  let largeMs = 0
  for (const fraction of GROWTH_FRACTIONS) {
    const ms = minTime(work(fraction))
    points.push([Math.log(fraction), Math.log(Math.max(ms, Number.MIN_VALUE))])
    largeMs = ms
  }
  return { slope: slopeOf(points), largeMs }
}
