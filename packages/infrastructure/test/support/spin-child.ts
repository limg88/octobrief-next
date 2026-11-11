// Test-only child entries standing in for a hostile parser.
// Usage: node spin-child.ts <spin|oom|env|garbage|big|exit> [pid-file]
import { renameSync, writeFileSync } from 'node:fs'
import { startWatchdog } from '../../src/extract/watchdog.ts'

// The same protection as the real extraction child, so the tests exercise it.
startWatchdog(process.argv)

/** Backstop: a spinning test child never outlives this, whatever happens to its parent. */
const SPIN_CAP_MS = 30_000

const mode = process.argv[2]
if (mode === 'spin') {
  const pidFile = process.argv[3]
  if (pidFile && !pidFile.startsWith('--')) {
    // Written then renamed, so a reader never sees a partial PID.
    writeFileSync(`${pidFile}.tmp`, String(process.pid))
    renameSync(`${pidFile}.tmp`, pidFile)
  }
  process.stdin.resume()
  const end = Date.now() + SPIN_CAP_MS
  while (Date.now() < end) {
    /* a parser that never returns */
  }
  process.exit(4)
} else if (mode === 'oom') {
  const keep: number[][] = []
  for (;;) keep.push(new Array<number>(1_000_000).fill(1))
} else if (mode === 'env') {
  process.stdout.write(
    JSON.stringify({
      extractor: JSON.stringify(Object.keys(process.env).sort()),
      chunks: [],
      truncated: false,
      metadataDate: null,
      warnings: [],
    }),
  )
} else if (mode === 'big') {
  process.stdout.write('x'.repeat(80 * 1024 * 1024))
} else if (mode === 'exit') {
  process.exit(3)
} else {
  process.stdout.write('not json')
}
