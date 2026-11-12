/** Waits, or stops waiting at once when the signal fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Runs a task now and then again every `minutes`, counted from the end of a run so that a slow
 * one never overlaps the next, until the signal fires. A run that fails is reported and the
 * loop goes on. Returns how many runs were made.
 */
export async function every(
  minutes: number,
  task: () => Promise<void>,
  options: { signal: AbortSignal; onError: (error: unknown) => void; wait?: typeof sleep },
): Promise<number> {
  const wait = options.wait ?? sleep
  let runs = 0
  while (!options.signal.aborted) {
    try {
      await task()
    } catch (error) {
      options.onError(error)
    }
    runs++
    await wait(minutes * 60_000, options.signal)
  }
  return runs
}
