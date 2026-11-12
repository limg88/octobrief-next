import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderSyncFile, SYNC_SUBFOLDERS, type SyncFile } from '@octobrief/connectors'
import type { Delivery, ExternalDocument, SourceKind } from '@octobrief/domain'
import { recordBody, rowsBody } from './body.ts'
import type { StateStore, WrittenItem } from './state.ts'

/** What one delivery changed in the folder. */
export interface WriteOutcome {
  written: number
  unchanged: number
  removed: number
}

export interface FolderWriterOptions {
  /** How an item was read when not by a deterministic connector (`claude`): kept in the header. */
  readonly via?: string
  /** The subfolder of a document inside the system's folder (mail, meetings, files…). */
  readonly groupOf?: (document: ExternalDocument) => string | null
}

const TEXT_TYPES = /^text\/|^application\/json$/
const MARKDOWN = 'text/markdown'
const SLUG_MAX_LENGTH = 60
const HASH_LENGTH = 8
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

/** A part of a file name: letters, digits and dashes only, never a path. */
export function slug(text: string): string {
  const clean = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '') || 'elemento'
}

const shortHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH)

/** Written whole and then renamed: Octobrief never reads half a file. */
function writeWhole(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${shortHash(path)}.tmp`)
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

/** Removes a file and the folders it leaves empty, up to the system's folder. */
function removeFile(root: string, system: string, path: string): void {
  rmSync(join(root, path), { force: true })
  for (let dir = dirname(path); dir !== system && dir !== '.'; dir = dirname(dir)) {
    const full = join(root, dir)
    if (!existsSync(full) || readdirSync(full).length > 0) return
    rmSync(full, { recursive: true, force: true })
  }
}

const day = (at: Date | null): string => (at ? `${at.toISOString().slice(0, 10)}-` : '')

/**
 * Writes what a system brought into its subfolder of the synchronized folder: a file for each
 * item, written again only when its version changes, removed when the item is gone. The state
 * remembers what was written; it is saved by the caller, together with the cursor.
 */
export function createFolderWriter(root: string, state: StateStore) {
  function write(
    system: SourceKind,
    delivery: Delivery,
    options: FolderWriterOptions = {},
  ): WriteOutcome {
    const sub = SYNC_SUBFOLDERS[system]
    const known = state.system(system)
    const outcome: WriteOutcome = { written: 0, unchanged: 0, removed: 0 }
    const back: string[] = []

    /** Writes the file of an item unless this version is already there. */
    function put(id: string, version: string, path: string, content: () => string | Uint8Array) {
      const before = known.items[id]
      if (before?.version === version && before.path === path && existsSync(join(root, path))) {
        outcome.unchanged++
        return
      }
      if (before && before.path !== path) removeFile(root, sub, before.path)
      writeWhole(join(root, path), content())
      known.items[id] = { version, path }
      back.push(id)
      outcome.written++
    }

    const header = { system, ...(options.via ? { via: options.via } : {}) }
    for (const document of delivery.documents) {
      const group = options.groupOf?.(document)
      const name = `${day(document.originAt)}${slug(document.title)}-${shortHash(document.externalId)}`
      const base = [sub, ...(group ? [group] : []), name].join('/')
      const mediaType = document.mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!TEXT_TYPES.test(mediaType)) {
        // A file that is not text is kept as it is: Octobrief reads it as a plain document.
        const path = `${base}${EXTENSIONS[mediaType] ?? '.bin'}`
        put(document.externalId, document.version, path, () => document.bytes)
        continue
      }
      const file: SyncFile = {
        ...header,
        type: 'document',
        externalId: document.externalId,
        version: document.version,
        title: document.title,
        originAt: document.originAt,
        url: document.url,
        people: document.people,
        ...(document.systemKind ? { systemKind: document.systemKind } : {}),
        ...(mediaType !== MARKDOWN ? { mediaType } : {}),
        body: new TextDecoder('utf-8', { fatal: false }).decode(document.bytes),
      }
      put(document.externalId, document.version, `${base}.md`, () => renderSyncFile(file))
    }
    for (const record of delivery.records) {
      const key = typeof record.record.key === 'string' ? record.record.key : record.externalId
      const path = `${sub}/${slug(key)}-${shortHash(record.externalId)}.md`
      put(record.externalId, record.version, path, () =>
        renderSyncFile({ ...header, type: 'record', record, body: recordBody(record) }),
      )
    }
    for (const rows of delivery.rows) {
      const id = `rows:${rows.view}:${rows.perimeter}`
      const path = `${sub}/${slug(rows.view)}/${slug(rows.perimeter)}.md`
      const version = shortHash(JSON.stringify(rows.rows))
      put(id, version, path, () =>
        renderSyncFile({ ...header, type: 'rows', rows, body: rowsBody(rows) }),
      )
    }
    const gone: string[] = []
    for (const id of delivery.removed) {
      const before = known.items[id]
      if (before) {
        removeFile(root, sub, before.path)
        delete known.items[id]
      }
      gone.push(id)
      outcome.removed++
    }
    state.setRemoved(system, gone, back)
    if (delivery.dataAsOf) known.dataAsOf = delivery.dataAsOf.toISOString()
    return outcome
  }

  /** Empties the folder of a system: every file removed, every item marked as gone. */
  function clear(system: SourceKind): number {
    const sub = SYNC_SUBFOLDERS[system]
    const known = state.system(system)
    const ids = Object.keys(known.items)
    for (const id of ids) removeFile(root, sub, (known.items[id] as WrittenItem).path)
    known.items = {}
    state.setRemoved(system, ids, [])
    return ids.length
  }
  return { write, clear }
}

export type FolderWriter = ReturnType<typeof createFolderWriter>
