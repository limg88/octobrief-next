import { join } from 'node:path'
import { readFolderBatch, SYNC_SUBFOLDERS } from '@octobrief/connectors'
import type { SourceKind } from '@octobrief/domain'
import type { Provider } from '../feeder.ts'
import { toWire } from '../wire.ts'

/** Files of one delivery: small enough to stay well under the size of a call. */
const FILES_PER_DELIVERY = 10

/**
 * Every readable file under a folder of the PM's computer (a synced SharePoint library, a
 * project folder): the path inside the folder names the item, its size and change time are its
 * version, so an unchanged file is not stored again. With `system`, the folder is a synchronized
 * one and what is sent is the subfolder of that system, each file as its header says.
 */
export function folderProvider(root: string, system?: SourceKind): Provider {
  const dir = system ? join(root, SYNC_SUBFOLDERS[system]) : root
  return {
    name: 'folder',
    async *deliveries() {
      for (let offset: number | null = 0; offset !== null; ) {
        const batch = await readFolderBatch({
          dir,
          offset,
          limit: FILES_PER_DELIVERY,
          ...(system ? { sync: { root, system } } : {}),
        })
        yield toWire(batch)
        offset = batch.nextOffset
      }
    },
  }
}
