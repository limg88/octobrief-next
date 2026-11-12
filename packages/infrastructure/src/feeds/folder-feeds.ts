import { realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { FeedError, type FolderFeeds } from '@octobrief/application'
import { readFolderBatch, SYNC_SUBFOLDERS } from '@octobrief/connectors'

/** Stored when the installation allows no synchronized folder (`SYNC_FOLDERS_ROOT` not set). */
export const FOLDER_FEED_DISABLED = 'folder_feed_disabled'
/** Stored when the folder, or the subfolder of the system, is not there. */
export const FOLDER_NOT_FOUND = 'folder_not_found'
/** Stored when the folder is outside the root the installation allows. */
export const FOLDER_NOT_ALLOWED = 'folder_not_allowed'

export interface FolderFeedsOptions {
  /** The only place synchronized folders may be under; null turns the feature off. */
  readonly root: string | null
}

/** The real path of a folder; a `FeedError` when it is not there or is not a folder. */
async function realFolder(path: string): Promise<string> {
  try {
    const real = await realpath(path)
    if ((await stat(real)).isDirectory()) return real
  } catch {
    // Not there, or not readable: the same answer.
  }
  throw new FeedError(FOLDER_NOT_FOUND)
}

const offsetOf = (cursor: unknown): number => {
  const offset = (cursor as { offset?: unknown } | null)?.offset
  return typeof offset === 'number' && Number.isInteger(offset) && offset > 0 ? offset : 0
}

/**
 * Synchronized folders on this machine. A folder is read only under the root the installation
 * names, compared by real paths, so a link cannot lead elsewhere; the check is repeated at every
 * reading, because what a path points to may change.
 */
export function createFolderFeeds(options: FolderFeedsOptions): FolderFeeds {
  async function check(folderPath: string): Promise<string> {
    if (options.root === null) throw new FeedError(FOLDER_FEED_DISABLED)
    const root = await realFolder(options.root).catch(() => {
      throw new FeedError(FOLDER_FEED_DISABLED)
    })
    const folder = await realFolder(folderPath)
    if (folder !== root && !folder.startsWith(root + sep)) throw new FeedError(FOLDER_NOT_ALLOWED)
    return folder
  }

  return {
    check,
    async read(kind, folderPath, cursor) {
      const root = await check(folderPath)
      const dir = await realFolder(join(root, SYNC_SUBFOLDERS[kind]))
      const batch = await readFolderBatch({
        dir,
        sync: { root, system: kind },
        offset: offsetOf(cursor),
      })
      return {
        ...batch,
        nextCursor: batch.nextOffset === null ? null : { offset: batch.nextOffset },
        done: batch.nextOffset === null,
      }
    },
  }
}
