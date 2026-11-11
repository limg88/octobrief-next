// Self-protection of the extraction child: a parser stuck in a loop blocks the child's main
// thread, so no timer there can fire. The watchdog runs in its own thread and ends the whole
// process when the parent is gone or when the hard time limit passes.
import { Worker } from 'node:worker_threads'

/** How often the watchdog looks for the parent, in ms. */
export const WATCHDOG_POLL_MS = 1_000
/** Extra time past the parent's timeout before the child ends itself, in ms. */
export const SELF_LIMIT_GRACE_MS = 5_000
/** Self limit when the parent passed no timeout, in ms. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Argument names the parent passes after the child's own arguments. */
export const PARENT_PID_ARG = '--parent-pid='
export const TIMEOUT_ARG = '--timeout-ms='

/** The longest delay a timer takes: beyond it Node fires the timer at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1

function numberArg(argv: readonly string[], prefix: string): number | undefined {
  const raw = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  const value = Number(raw)
  return raw && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * What the watchdog watches: the parent (`--parent-pid=`, default the parent at start) and the
 * self limit, the parent's timeout (`--timeout-ms=`) plus `SELF_LIMIT_GRACE_MS`, kept within
 * what a timer takes (a longer one would end the child at once).
 */
export function watchdogSettings(
  argv: readonly string[],
  ppid: number,
): { parentPid: number; limitMs: number } {
  const timeout = numberArg(argv, TIMEOUT_ARG) ?? DEFAULT_TIMEOUT_MS
  return {
    parentPid: numberArg(argv, PARENT_PID_ARG) ?? ppid,
    limitMs: Math.min(timeout + SELF_LIMIT_GRACE_MS, MAX_TIMER_MS),
  }
}

// Plain JavaScript run in the watchdog thread. SIGKILL on the own PID ends every thread at once;
// `process.exit` there would end only the watchdog thread.
const WATCHDOG_SOURCE = `
const { workerData } = require('node:worker_threads')
const end = () => process.kill(process.pid, 'SIGKILL')
setTimeout(end, workerData.limitMs)
setInterval(() => {
  if (process.ppid !== workerData.parentPid) end()
}, workerData.pollMs)
`

/**
 * Starts the watchdog thread. It ends this process when its parent (`--parent-pid=`, default the
 * parent at start) is no longer its parent, checked every `WATCHDOG_POLL_MS`, and after the
 * parent's timeout (`--timeout-ms=`) plus `SELF_LIMIT_GRACE_MS`. It never keeps the process alive.
 */
export function startWatchdog(argv: readonly string[]): void {
  const { parentPid, limitMs } = watchdogSettings(argv, process.ppid)
  const watchdog = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { parentPid, limitMs, pollMs: WATCHDOG_POLL_MS },
  })
  watchdog.unref()
}
