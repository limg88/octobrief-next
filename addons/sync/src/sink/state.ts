import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYNC_REMOVED_FILE, SYNC_STATE_DIR, SYNC_STATE_FILE } from '@octobrief/connectors'
import type { SourceKind } from '@octobrief/domain'

/** What the add-on remembers of one item it wrote: its version and where its file is. */
export interface WrittenItem {
  readonly version: string
  /** Path of the file, relative to the synchronized folder. */
  readonly path: string
}

/** What the add-on remembers of one system between two runs. */
export interface SystemState {
  /** Up to when the system's data has been read: Octobrief reads it as the freshness. */
  dataAsOf: string | null
  /** Where the next reading starts (the cursor of the connector, or the day reached). */
  cursor: unknown
  /** The start day the cursor was built from: a different one starts again. */
  since: string | null
  lastRunAt: string | null
  /** A stable code of what went wrong at the last run, or null. */
  lastError: string | null
  /** What of the system the items were read from (see `SystemSource.scope`); absent: all of it. */
  scope?: string
  items: Record<string, WrittenItem>
}

export type SyncState = Partial<Record<SourceKind, SystemState>>

export const emptySystem = (): SystemState => ({
  dataAsOf: null,
  cursor: null,
  since: null,
  lastRunAt: null,
  lastError: null,
  items: {},
})

function readJson<T>(path: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

/** Written whole to a temporary file and then renamed: a reader never sees half a file. */
function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** The state of a synchronized folder, kept in its hidden `.octobrief-sync` folder. */
export function openState(root: string) {
  const dir = join(root, SYNC_STATE_DIR)
  const statePath = join(dir, SYNC_STATE_FILE)
  const removedPath = join(dir, SYNC_REMOVED_FILE)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const state = readJson<SyncState>(statePath, {})
  const removed = readJson<Partial<Record<SourceKind, string[]>>>(removedPath, {})
  return {
    system(kind: SourceKind): SystemState {
      state[kind] ??= emptySystem()
      return state[kind]
    },
    all: (): SyncState => state,
    /** Marks items as gone at their source, or back: Octobrief reads the list at each look. */
    setRemoved(kind: SourceKind, gone: readonly string[], back: readonly string[]): void {
      const now = new Set(removed[kind] ?? [])
      for (const id of gone) now.add(id)
      for (const id of back) now.delete(id)
      removed[kind] = [...now].sort()
    },
    removedOf: (kind: SourceKind): readonly string[] => removed[kind] ?? [],
    save(): void {
      writeJson(statePath, state)
      writeJson(removedPath, removed)
    },
  }
}

export type StateStore = ReturnType<typeof openState>
