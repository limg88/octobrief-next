import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import {
  type Delivery,
  DOCUMENT_KINDS,
  type ExternalDocument,
  type ExternalRecord,
  type ExternalRows,
  MAX_ITEM_BYTES,
  MAX_ITEMS_PER_DELIVERY,
  MAX_ROWS_PER_DELIVERY,
  type SourceKind,
} from '@octobrief/domain'
import { parseSyncFile } from './sync-file.ts'

/** The files a folder is read for, by extension; anything else is left where it is. */
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
/** Files one folder is read for at most: a larger one is read in part. */
export const MAX_FOLDER_FILES = 2_000
const MAX_DEPTH = 8
const MARKDOWN = '.md'

/** Where a synchronization keeps what is not an item: hidden, so never read as a document. */
export const SYNC_STATE_DIR = '.octobrief-sync'
/** External ids of the items that are gone at their source: `{ "<system>": ["<id>", …] }`. */
export const SYNC_REMOVED_FILE = 'removed.json'
/** Up to when each system was read: `{ "<system>": { "dataAsOf": "<ISO>" } }`. */
export const SYNC_STATE_FILE = 'state.json'

/** The subfolder of a synchronized folder that holds the items of each kind of source. */
export const SYNC_SUBFOLDERS: Readonly<Record<SourceKind, string>> = {
  jira: 'jira',
  ado: 'ado',
  m365: 'm365',
  dwsi: 'netsuite',
  files: 'files',
}

const isDocumentKind = (kind: string | undefined): kind is string =>
  kind !== undefined && (DOCUMENT_KINDS as readonly string[]).includes(kind)

const isFolderText = (mediaType: string | undefined): mediaType is string =>
  mediaType !== undefined &&
  mediaType.startsWith('text/') &&
  Object.values(FOLDER_MEDIA_TYPES).includes(mediaType)

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Hidden files and links are never followed: a link could lead outside the folder.
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) yield* walk(path, depth + 1)
    } else if (entry.isFile() && FOLDER_MEDIA_TYPES[extname(entry.name).toLowerCase()]) {
      yield path
    }
  }
}

/** The readable files under a folder, in a stable order, as paths relative to it. */
export async function listFolder(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const path of walk(root, 0)) {
    if (files.length >= MAX_FOLDER_FILES) break
    files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What the synchronization says of a system beside its items: what is gone, how fresh it is. */
async function closingOf(root: string, system: SourceKind | undefined) {
  if (!system) return { removed: [], dataAsOf: null }
  const removed = (await readJson(join(root, SYNC_STATE_DIR, SYNC_REMOVED_FILE)))[system]
  const state = (await readJson(join(root, SYNC_STATE_DIR, SYNC_STATE_FILE)))[system]
  const stamp = (state as { dataAsOf?: unknown } | undefined)?.dataAsOf
  const dataAsOf = typeof stamp === 'string' ? new Date(stamp) : null
  return {
    removed: Array.isArray(removed) ? removed.filter((id) => typeof id === 'string') : [],
    dataAsOf: dataAsOf && !Number.isNaN(dataAsOf.getTime()) ? dataAsOf : null,
  }
}

export interface FolderBatchOptions {
  /** The folder of one system: `<synchronized folder>/<subfolder>`, or any folder of files. */
  readonly dir: string
  /**
   * The synchronized folder the system's folder belongs to and the system read: sync files of
   * another system are left out, removals and freshness are read from the state. Without them
   * the folder is a plain folder of documents.
   */
  readonly sync?: { readonly root: string; readonly system: SourceKind } | undefined
  /** How many files of the listing were read by the batches before this one. */
  readonly offset: number
  readonly limit?: number
}

export interface FolderBatch extends Delivery {
  /** Where the next batch starts; null when the folder has been read to its end. */
  readonly nextOffset: number | null
}

/**
 * Reads the next files of a folder as a delivery. A sync file becomes what its header says (a
 * document, a tracker item, the rows of a view); any other file is a document named by its path,
 * whose size and change time are its version. The last batch carries what is gone and how fresh
 * the data is.
 */
export async function readFolderBatch(options: FolderBatchOptions): Promise<FolderBatch> {
  const limit = options.limit ?? MAX_ITEMS_PER_DELIVERY
  const files = await listFolder(options.dir)
  const documents: ExternalDocument[] = []
  const records: ExternalRecord[] = []
  const rows: ExternalRows[] = []
  let rowCount = 0
  let at = options.offset
  for (; at < files.length && documents.length + records.length < limit; at++) {
    const name = files[at] as string
    const path = join(options.dir, name)
    const info = await stat(path)
    if (info.size === 0 || info.size > MAX_ITEM_BYTES) continue
    const bytes = await readFile(path)
    const file =
      extname(name).toLowerCase() === MARKDOWN ? parseSyncFile(bytes.toString('utf8')) : null
    if (file && options.sync && file.system !== options.sync.system) continue
    if (file?.type === 'rows') {
      const size = file.rows.rows.length
      if (size > MAX_ROWS_PER_DELIVERY) continue
      // A view that does not fit with the ones already read opens the next batch.
      if (rowCount + size > MAX_ROWS_PER_DELIVERY) break
      rowCount += size
      rows.push(file.rows)
    } else if (file?.type === 'record') {
      records.push(file.record)
    } else if (file?.type === 'document') {
      // A header with nothing under it says nothing to read.
      if (file.body.trim() === '') continue
      documents.push({
        externalId: file.externalId,
        version: file.version,
        title: file.title,
        // Only a kind of text a folder is read for: a header cannot make a text pass for a binary.
        mediaType: isFolderText(file.mediaType) ? file.mediaType : 'text/markdown',
        bytes: new TextEncoder().encode(file.body),
        originAt: file.originAt,
        url: file.url,
        people: file.people,
        // A kind Octobrief does not know is left to its own classification.
        ...(isDocumentKind(file.systemKind) ? { systemKind: file.systemKind } : {}),
      })
    } else {
      documents.push({
        externalId: name,
        version: `${info.size}-${info.mtimeMs.toFixed(0)}`,
        title: name.split('/').at(-1) as string,
        mediaType: FOLDER_MEDIA_TYPES[extname(name).toLowerCase()] as string,
        bytes: new Uint8Array(bytes),
        originAt: null,
        url: null,
        // The change time of a file is not the date of what it says: a weaker hint.
        fileModifiedAt: info.mtime,
        people: [],
      })
    }
  }
  const done = at >= files.length
  const closing = done
    ? await closingOf(options.sync?.root ?? options.dir, options.sync?.system)
    : { removed: [], dataAsOf: null }
  return {
    documents,
    records,
    rows,
    removed: closing.removed,
    // A plain folder is as fresh as the moment it was read to its end.
    dataAsOf: done ? (closing.dataAsOf ?? (options.sync ? null : new Date())) : null,
    nextOffset: done ? null : at,
  }
}
