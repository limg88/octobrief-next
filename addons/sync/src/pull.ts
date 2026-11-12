import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectorError } from '@octobrief/connectors'
import type { SourceKind } from '@octobrief/domain'
import { type SyncConfig, sinceOf } from './config.ts'
import { FeederError } from './feeder.ts'
import { createFolderWriter, type WriteOutcome } from './sink/folder-writer.ts'
import { openState, type SystemState } from './sink/state.ts'
import type { SystemSource } from './sources/source.ts'
import { patWarning, renderStatus } from './status.ts'

/** The readable report of the folder: not an item of any system, so not under a subfolder. */
export const STATUS_FILE = '_stato.md'
/** Stored when a run fails for a reason that has no code of its own. */
const UNEXPECTED_FAILURE = 'sync_failed'

export interface PullOptions {
  /** A start day given on the command line: wins over the configuration. */
  readonly since?: string | undefined
  readonly now?: () => Date
  readonly log?: (line: string) => void
  readonly signal?: AbortSignal
}

export interface SystemOutcome extends WriteOutcome {
  readonly system: SourceKind
  /** A stable code of what went wrong, or null. */
  readonly error: string | null
}

/** The code of a failure and, when a provider says which step failed, that step: never a value. */
function codeOf(error: unknown): string {
  if (error instanceof ConnectorError) return error.code
  if (error instanceof FeederError) return `${error.code}: ${error.message}`
  return UNEXPECTED_FAILURE
}

/**
 * Where a run starts. A start day earlier than the one the cursor was built from starts again
 * from it, so that the missing period is read; a later one changes nothing (what was written
 * stays, and the cursor is already past it).
 */
export function resumeFrom(known: SystemState, source: SystemSource, since: Date | null): unknown {
  const wanted = since?.toISOString() ?? null
  const earlier =
    known.since !== wanted && (wanted === null || (known.since !== null && wanted < known.since))
  const cursor =
    known.cursor === null || known.cursor === undefined || earlier
      ? source.startCursor(since)
      : known.cursor
  // The day kept is the earliest ever read from: that is what the folder holds.
  if (known.lastRunAt === null || earlier) known.since = wanted
  return cursor
}

/**
 * Brings the folder up to date: each system is read from where its last run stopped and written
 * into its subfolder; the cursor is saved after every batch, so an interrupted run loses
 * nothing. A system that fails is reported and does not stop the others.
 */
export async function runPull(
  config: SyncConfig,
  sources: readonly SystemSource[],
  options: PullOptions = {},
): Promise<SystemOutcome[]> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const signal = options.signal ?? new AbortController().signal
  mkdirSync(config.folder, { recursive: true })
  const state = openState(config.folder)
  const writer = createFolderWriter(config.folder, state)
  const outcomes: SystemOutcome[] = []

  for (const source of sources) {
    const known = state.system(source.system)
    const startedAt = now()
    const total: WriteOutcome = { written: 0, unchanged: 0, removed: 0 }
    let error: string | null = null
    try {
      const cursor = resumeFrom(known, source, sinceOf(config, source.system, options.since))
      const freshBefore = known.dataAsOf
      for await (const batch of source.batches(cursor, signal)) {
        const outcome = writer.write(source.system, batch.delivery, batch.writer ?? source.writer)
        known.cursor = batch.cursor
        state.save()
        total.written += outcome.written
        total.unchanged += outcome.unchanged
        total.removed += outcome.removed
      }
      // A system that does not say how fresh it is was read up to the start of this run.
      if (known.dataAsOf === freshBefore) known.dataAsOf = startedAt.toISOString()
    } catch (failure) {
      error = codeOf(failure)
    }
    known.lastRunAt = startedAt.toISOString()
    known.lastError = error
    state.save()
    outcomes.push({ system: source.system, ...total, error })
    log(
      error
        ? `${source.system}: non riuscita (${error})`
        : `${source.system}: ${total.written} scritti, ${total.unchanged} invariati, ${total.removed} rimossi`,
    )
  }
  const warning = patWarning(config, now())
  if (warning) log(`ATTENZIONE: ${warning}`)
  writeFileSync(join(config.folder, STATUS_FILE), renderStatus(config, state.all(), now()))
  return outcomes
}
