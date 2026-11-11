import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MAX_TIMER_MS,
  PARENT_PID_ARG,
  SELF_LIMIT_GRACE_MS,
  TIMEOUT_ARG,
  watchdogSettings,
} from '../src/extract/watchdog.ts'

const parentEntry = fileURLToPath(new URL('./support/abrupt-parent.ts', import.meta.url))
const spinEntry = fileURLToPath(new URL('./support/spin-child.ts', import.meta.url))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: no such process. EPERM: the PID was recycled by someone else's process. Either way
    // ours is gone.
    return false
  }
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return condition()
}

describe('the limits of the extraction child watchdog', () => {
  it('stay within what a timer takes, whatever timeout the parent passes', () => {
    expect(watchdogSettings([`${TIMEOUT_ARG}1000`], 7)).toEqual({
      parentPid: 7,
      limitMs: 1000 + SELF_LIMIT_GRACE_MS,
    })
    for (const huge of [String(MAX_TIMER_MS), '9999999999', '99999999999999999999']) {
      const { limitMs } = watchdogSettings([`${TIMEOUT_ARG}${huge}`], 7)
      expect(limitMs, huge).toBeLessThanOrEqual(MAX_TIMER_MS)
      expect(limitMs, huge).toBeGreaterThan(60_000)
    }
    // A malformed or absent value: the default, never zero or a fraction.
    for (const bad of ['0', '-5', '1.5', 'abc', '']) {
      expect(watchdogSettings([`${TIMEOUT_ARG}${bad}`], 7).limitMs, bad).toBe(
        60_000 + SELF_LIMIT_GRACE_MS,
      )
    }
    expect(watchdogSettings([`${PARENT_PID_ARG}${2 ** 60}`], 7).parentPid).toBe(7)
    expect(watchdogSettings([`${PARENT_PID_ARG}42`], 7).parentPid).toBe(42)
  })
})

describe('extraction child watchdog', () => {
  it('a spinning child stops by itself when the parent dies abruptly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octobrief-orphan-'))
    const pidFile = join(dir, 'child.pid')
    let childPid: number | undefined
    try {
      const parent = spawn(
        process.execPath,
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          parentEntry,
          pidFile,
        ],
        { stdio: 'ignore' },
      )
      const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
        parent.on('exit', (_code, s) => resolve(s)),
      )
      expect(signal).toBe('SIGKILL')
      childPid = Number(readFileSync(pidFile, 'utf8'))
      expect(childPid).toBeGreaterThan(0)
      // The watchdog polls every second; a few seconds cover scheduling under load.
      const pid = childPid
      expect(await waitUntil(() => !isAlive(pid), 8_000)).toBe(true)
    } finally {
      // Backstop only: never leave a spinning child behind if the assertion failed.
      if (childPid !== undefined && isAlive(childPid)) process.kill(childPid, 'SIGKILL')
      rmSync(dir, { recursive: true })
    }
  }, 40_000)

  it('a spinning child ends itself after the timeout plus the grace, parent alive', async () => {
    // Spawned directly, so no parent timer stops it: only its own time limit can.
    const started = performance.now()
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        spinEntry,
        'spin',
        PARENT_PID_ARG + String(process.pid),
        `${TIMEOUT_ARG}500`,
      ],
      { stdio: 'ignore' },
    )
    const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
      child.on('exit', (_code, s) => resolve(s)),
    )
    const elapsed = performance.now() - started
    expect(signal).toBe('SIGKILL')
    expect(elapsed).toBeGreaterThanOrEqual(500 + SELF_LIMIT_GRACE_MS)
    // Well below the 30 s cap of the test child: the limit, not the cap, ended it.
    expect(elapsed).toBeLessThan(20_000)
  }, 40_000)
})
