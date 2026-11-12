import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { MAX_ITEM_BYTES } from '@octobrief/domain'
import type { Provider } from '../feeder.ts'
import type { WireDocument } from '../wire.ts'

/** The files a folder source reads, by extension; anything else is left where it is. */
export const FOLDER_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.vtt': 'text/vtt',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
/** Files one run reads at most: a folder larger than this is read in part, and says so. */
export const MAX_FOLDER_FILES = 2_000
const MAX_DEPTH = 8
/** Files of one delivery: small enough to stay well under the size of a call. */
const FILES_PER_DELIVERY = 10

async function* walk(root: string, dir: string, depth: number): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Hidden files and links are never followed: a link could lead outside the folder.
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) yield* walk(root, path, depth + 1)
    } else if (entry.isFile() && FOLDER_MEDIA_TYPES[extname(entry.name).toLowerCase()]) {
      yield path
    }
  }
}

/**
 * Every readable file under a folder of the PM's computer (a synced SharePoint library, a
 * project folder). The path inside the folder names the item; its size and change time are its
 * version, so an unchanged file is not stored again.
 */
export function folderProvider(root: string): Provider {
  return {
    name: 'folder',
    async *deliveries() {
      let documents: WireDocument[] = []
      let files = 0
      for await (const path of walk(root, root, 0)) {
        if (files >= MAX_FOLDER_FILES) break
        const info = await stat(path)
        if (info.size === 0 || info.size > MAX_ITEM_BYTES) continue
        files++
        const name = relative(root, path).split(sep).join('/')
        documents.push({
          externalId: name,
          version: `${info.size}-${info.mtimeMs.toFixed(0)}`,
          title: name.split('/').at(-1) as string,
          mediaType: FOLDER_MEDIA_TYPES[extname(path).toLowerCase()] as string,
          contentBase64: (await readFile(path)).toString('base64'),
          // The change time of a file is not the date of what it says: a weaker hint.
          fileModifiedAt: info.mtime.toISOString(),
        })
        if (documents.length === FILES_PER_DELIVERY) {
          yield { documents }
          documents = []
        }
      }
      yield { documents, dataAsOf: new Date().toISOString() }
    },
  }
}
