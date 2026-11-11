import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Extraction } from '@octobrief/domain'
import { MAX_TEXT_CHARS } from './limits.ts'
import { failed, result } from './result.ts'
import { MAX_TIMER_MS, PARENT_PID_ARG, TIMEOUT_ARG } from './watchdog.ts'

/** The child is stopped after this long. */
export const EXTRACTION_TIMEOUT_MS = 60_000
/** Time between the polite stop and the forced one. */
const FORCE_AFTER_MS = 2_000
/** Old-space limit of the child, in MB. */
const CHILD_MAX_OLD_SPACE_MB = 512
/**
 * Output cap: 6 bytes per character of the text limit, the worst case of the text itself (a
 * control character becomes a six-character escape in the JSON). The JSON around the text
 * (chunks, locators, warnings) is not counted apart: an answer at that worst case goes over the
 * cap and is a truncated empty result, never a partial one.
 */
const MAX_OUTPUT_BYTES = 6 * MAX_TEXT_CHARS

export interface IsolatedOptions {
  /** Timeout of the child; default 60 s. */
  timeoutMs?: number
  /** Stops the child when aborted (the worker passes the job signal). */
  signal?: AbortSignal
  /**
   * Entry script of the child. Test-only: it is executed as code, so it must never be derived
   * from user input. Default is the extraction entry (`child.ts`).
   */
  childEntry?: string
  /**
   * Extra arguments after the entry. Test-only, like `childEntry`: the extraction entry takes
   * none.
   */
  childArgs?: string[]
}

/**
 * The timeout of a child as the timers take it: the default when none or not a positive
 * duration, at most `MAX_TIMER_MS` (a longer timer would fire at once, here and in the child's
 * watchdog).
 */
export function childTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested) || requested <= 0) {
    return EXTRACTION_TIMEOUT_MS
  }
  return Math.min(Math.ceil(requested), MAX_TIMER_MS)
}

const DEFAULT_ENTRY = fileURLToPath(new URL('./child.ts', import.meta.url))

// Children alive now: when this process exits normally they are stopped too. A parent that dies
// abruptly (SIGKILL, OOM) runs no handler; then the child's own watchdog ends it (watchdog.ts).
const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL')
})

/** Content-free note on a failed child: what happened, never what the file or the child said. */
function diagnose(what: string, code: number | null, signal: NodeJS.Signals | null): void {
  console.error(
    `extraction child failed: ${what} (exit ${code ?? 'none'}, signal ${signal ?? 'none'})`,
  )
}

// One child at a time per process: bounds memory (each child may take up to 512 MB).
let tail: Promise<unknown> = Promise.resolve()
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run)
  tail = next.catch(() => undefined)
  return next
}

/**
 * Wire format. stdin: a 4-byte big-endian length N, then N bytes of UTF-8 JSON
 * `{ mediaType, fileName }`, then the file bytes up to EOF. stdout: the Extraction as JSON
 * (`metadataDate` and `createdDate` as ISO strings).
 */
function frame(bytes: Uint8Array, mediaType: string, fileName: string): Buffer[] {
  const header = Buffer.from(JSON.stringify({ mediaType, fileName }), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return [length, header, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]
}

function parse(output: Buffer): Extraction | null {
  try {
    const value = JSON.parse(output.toString('utf8')) as Partial<Extraction> & {
      metadataDate?: string | null
      createdDate?: string | null
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof value.extractor !== 'string' ||
      !Array.isArray(value.chunks) ||
      !Array.isArray(value.warnings) ||
      typeof value.truncated !== 'boolean'
    )
      return null
    const date = value.metadataDate ? new Date(value.metadataDate) : null
    const created = value.createdDate ? new Date(value.createdDate) : null
    return {
      extractor: value.extractor,
      chunks: value.chunks,
      truncated: value.truncated,
      metadataDate: date && !Number.isNaN(date.getTime()) ? date : null,
      ...(created && !Number.isNaN(created.getTime()) ? { createdDate: created } : {}),
      warnings: value.warnings,
    }
  } catch {
    return null
  }
}

function run(
  bytes: Uint8Array,
  mediaType: string,
  fileName: string,
  options: IsolatedOptions,
): Promise<Extraction> {
  if (options.signal?.aborted) return Promise.resolve(failed('extraction_failed'))
  return new Promise((resolve) => {
    const timeoutMs = childTimeoutMs(options.timeoutMs)
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`,
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        options.childEntry ?? DEFAULT_ENTRY,
        ...(options.childArgs ?? []),
        // For the child's watchdog: it ends itself if this process dies or this timeout fails.
        PARENT_PID_ARG + String(process.pid),
        TIMEOUT_ARG + String(timeoutMs),
      ],
      // Only PATH is passed on: no secrets, no database or gateway settings.
      { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'ignore'] },
    )
    live.add(child)
    const out: Buffer[] = []
    let size = 0
    let outcome: 'timeout' | 'oversize' | 'aborted' | null = null
    let settled = false
    let stopping = false
    let forceTimer: NodeJS.Timeout | undefined

    const alive = () => child.exitCode === null && child.signalCode === null
    // Stops the child once: polite first, forced after the grace. Signals go through the child
    // handle and only while it has not exited, so a recycled PID is never hit.
    const stop = () => {
      if (stopping || !alive()) return
      stopping = true
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => {
        if (alive()) child.kill('SIGKILL')
      }, FORCE_AFTER_MS)
      forceTimer.unref()
    }
    const onAbort = () => {
      outcome ??= 'aborted'
      stop()
    }
    const timer = setTimeout(() => {
      outcome ??= 'timeout'
      stop()
    }, timeoutMs)
    const finish = (extraction: Extraction) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      live.delete(child)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(extraction)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > MAX_OUTPUT_BYTES) {
        outcome ??= 'oversize'
        out.length = 0
        stop()
        return
      }
      if (outcome) return
      out.push(part)
    })
    child.on('error', () => {
      diagnose('could not start', null, null)
      finish(failed('extraction_failed'))
    })
    child.on('close', (code, signal) => {
      if (outcome === 'timeout') return finish(failed('timeout'))
      if (outcome === 'oversize') return finish(result([], { truncated: true }))
      if (outcome === 'aborted') return finish(failed('extraction_failed'))
      const parsed = code === 0 ? parse(Buffer.concat(out)) : null
      if (!parsed) diagnose('no usable result', code, signal)
      finish(parsed ?? failed('extraction_failed'))
    })
    // The child may die before reading everything: a write error is not ours to throw.
    child.stdin.on('error', () => {})
    for (const part of frame(bytes, mediaType, fileName)) child.stdin.write(part)
    child.stdin.end()
  })
}

/**
 * `extract` in a child process with a memory limit, a timeout and no environment: a file that
 * makes the parser spin or eat memory costs the child, not the worker. It never throws: a timeout
 * is the warning `timeout`, a crash, an out-of-memory, an abort or an unreadable answer is
 * `extraction_failed`, an answer over the size cap is a truncated empty result. One child at a
 * time per process.
 */
export function extractIsolated(
  bytes: Uint8Array,
  mediaType: string,
  fileName: string,
  options: IsolatedOptions = {},
): Promise<Extraction> {
  return exclusive(() => run(bytes, mediaType, fileName, options)).catch(() =>
    failed('extraction_failed'),
  )
}
