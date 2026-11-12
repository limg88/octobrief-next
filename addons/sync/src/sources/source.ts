import type { Delivery, SourceKind } from '@octobrief/domain'
import type { FolderWriterOptions } from '../sink/folder-writer.ts'

/** What a system gave in one step, with where the next run starts once it has been written. */
export interface SourceBatch {
  readonly delivery: Delivery
  readonly cursor: unknown
  /** How the documents of this batch are written, when not as the source's others. */
  readonly writer?: FolderWriterOptions
}

/** A system the add-on reads into its subfolder of the synchronized folder. */
export interface SystemSource {
  readonly system: SourceKind
  /** How its documents are written (subfolders, how they were read). */
  readonly writer?: FolderWriterOptions
  /** Where a first reading starts: from the day given, or from the beginning. */
  startCursor(since: Date | null): unknown
  /** What the system has after `cursor`, step by step, up to now. */
  batches(cursor: unknown, signal: AbortSignal): AsyncIterable<SourceBatch>
}
