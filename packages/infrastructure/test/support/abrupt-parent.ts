// Test-only parent: starts a spinning extraction child that reports its PID to a file, then dies
// abruptly (SIGKILL), so no exit handler of this process can stop the child.
// Usage: node abrupt-parent.ts <pid-file>
import { existsSync } from 'node:fs'
import { extractIsolated } from '../../src/extract/isolated.ts'
import { hostile } from './modes.ts'

const pidFile = process.argv[2]
if (!pidFile) throw new Error('pid file path required')

// A long timeout: only the child's own watchdog can end it in time.
void extractIsolated(new Uint8Array([120]), 'text/plain', 'a.txt', {
  ...hostile('spin', { timeoutMs: 120_000 }),
  childArgs: ['spin', pidFile],
})

const started = Date.now()
const poll = setInterval(() => {
  if (existsSync(pidFile) || Date.now() - started > 20_000) {
    clearInterval(poll)
    process.kill(process.pid, 'SIGKILL')
  }
}, 50)
