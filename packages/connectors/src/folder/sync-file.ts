import {
  type ExternalRecord,
  type ExternalRows,
  type ItemPerson,
  SOURCE_KINDS,
  type SourceKind,
} from '@octobrief/domain'

/**
 * The file a synchronization writes for one item of a source system and Octobrief reads back: a
 * Markdown text a person can open, under a header that carries the data a text would lose (the
 * id and the version in the system, dates, people, the fields of a tracker item, the rows of a
 * view). The header is YAML written one key per line with a JSON value, so it is read without a
 * YAML parser and never guessed.
 */
export const SYNC_FILE_VERSION = 1
export const SYNC_FILE_TYPES = ['document', 'record', 'rows'] as const
export type SyncFileType = (typeof SYNC_FILE_TYPES)[number]

const FENCE = '---'
const VERSION_KEY = 'octobrief'
/** A header longer than this is not one: the rows of the largest view stay well under it. */
const MAX_HEADER_LINE_LENGTH = 64 * 1024 * 1024

interface SyncFileBase {
  readonly system: SourceKind
  /** How the item was read when not by a deterministic connector (for example `claude`). */
  readonly via?: string | undefined
  /** The readable text under the header. */
  readonly body: string
}

/** A text of the system: a mail, a meeting with its transcript, a file, an export. */
export interface SyncDocumentFile extends SyncFileBase {
  readonly type: 'document'
  readonly externalId: string
  readonly version: string
  readonly title: string
  readonly originAt: Date | null
  readonly url: string | null
  /** The kind the source declares for a document made from the system's data. */
  readonly systemKind?: string | undefined
  readonly people: readonly ItemPerson[]
}

/** A structured item of a tracker, with its text for the reader. */
export interface SyncRecordFile extends SyncFileBase {
  readonly type: 'record'
  readonly record: ExternalRecord
}

/** The rows of one view of a system of record, with the same table for the reader. */
export interface SyncRowsFile extends SyncFileBase {
  readonly type: 'rows'
  readonly rows: ExternalRows
}

export type SyncFile = SyncDocumentFile | SyncRecordFile | SyncRowsFile

const iso = (date: Date | null): string | null => date?.toISOString() ?? null

function headerOf(file: SyncFile): Array<[string, unknown]> {
  const head: Array<[string, unknown]> = [
    [VERSION_KEY, SYNC_FILE_VERSION],
    ['system', file.system],
    ['type', file.type],
  ]
  if (file.via) head.push(['via', file.via])
  if (file.type === 'rows') {
    const { rows } = file
    head.push(
      ['view', rows.view],
      ['perimeter', rows.perimeter],
      ['extractedAt', rows.extractedAt.toISOString()],
      ['sourceSyncedAt', iso(rows.sourceSyncedAt)],
      ['rows', rows.rows],
    )
    return head
  }
  const item = file.type === 'record' ? file.record : file
  head.push(
    ['externalId', item.externalId],
    ['version', item.version],
    ['title', item.title],
    ['originAt', iso(item.originAt)],
    ['url', item.url],
  )
  if (file.type === 'document' && file.systemKind) head.push(['kind', file.systemKind])
  head.push(['people', item.people])
  if (file.type === 'record') head.push(['record', file.record.record])
  return head
}

/** The text of a sync file: the header between two `---` lines, then the body. */
export function renderSyncFile(file: SyncFile): string {
  const lines = headerOf(file).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n${file.body}`
}

type Header = Readonly<Record<string, unknown>>

function readHeader(text: string): { header: Header; body: string } | null {
  if (!text.startsWith(`${FENCE}\n`)) return null
  const end = text.indexOf(`\n${FENCE}\n`, FENCE.length)
  if (end === -1) return null
  const header: Record<string, unknown> = {}
  for (const line of text.slice(FENCE.length + 1, end).split('\n')) {
    const colon = line.indexOf(': ')
    if (colon <= 0 || line.length > MAX_HEADER_LINE_LENGTH) return null
    try {
      header[line.slice(0, colon)] = JSON.parse(line.slice(colon + 2))
    } catch {
      return null
    }
  }
  return { header, body: text.slice(end + FENCE.length + 2) }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const optionalText = (value: unknown): string | null | undefined =>
  value === null || value === undefined ? null : (text(value) ?? undefined)
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A date of a header: null when absent, undefined when it is not a date. */
function dateOf(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function peopleOf(value: unknown): ItemPerson[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const people: ItemPerson[] = []
  for (const entry of value) {
    const displayName = isObject(entry) ? text(entry.displayName) : null
    if (!isObject(entry) || !displayName) return null
    const email = text(entry.email)
    people.push({
      displayName,
      ...(email ? { email } : {}),
      ...(entry.untrusted === true ? { untrusted: true } : {}),
    })
  }
  return people
}

function itemOf(header: Header) {
  const externalId = text(header.externalId)
  const version = text(header.version)
  const title = text(header.title)
  const originAt = dateOf(header.originAt)
  const url = optionalText(header.url)
  const people = peopleOf(header.people)
  if (!externalId || !version || !title || originAt === undefined || url === undefined) return null
  if (!people) return null
  return { externalId, version, title, originAt, url, people }
}

function rowsOf(header: Header): ExternalRows | null {
  const view = text(header.view)
  const perimeter = text(header.perimeter)
  const extractedAt = dateOf(header.extractedAt)
  const sourceSyncedAt = dateOf(header.sourceSyncedAt)
  if (!view || !perimeter || !extractedAt || sourceSyncedAt === undefined) return null
  if (!Array.isArray(header.rows)) return null
  const rows: Array<{ key: string; values: Record<string, unknown> }> = []
  for (const row of header.rows) {
    const key = isObject(row) ? text(row.key) : null
    if (!isObject(row) || !key || !isObject(row.values)) return null
    rows.push({ key, values: row.values })
  }
  return { view, perimeter, rows, extractedAt, sourceSyncedAt }
}

/**
 * Reads a sync file. Null when the text is not one — no header, another version, a field
 * missing or of the wrong shape: the caller then treats the file as a plain document.
 */
export function parseSyncFile(content: string): SyncFile | null {
  const read = readHeader(content)
  if (!read || read.header[VERSION_KEY] !== SYNC_FILE_VERSION) return null
  const { header, body } = read
  const system = header.system
  if (typeof system !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(system)) {
    return null
  }
  const via = text(header.via)
  const base = { system: system as SourceKind, body, ...(via ? { via } : {}) }
  if (header.type === 'rows') {
    const rows = rowsOf(header)
    return rows ? { ...base, type: 'rows', rows } : null
  }
  const item = itemOf(header)
  if (!item) return null
  if (header.type === 'record') {
    return isObject(header.record)
      ? { ...base, type: 'record', record: { ...item, record: header.record } }
      : null
  }
  if (header.type !== 'document') return null
  const systemKind = text(header.kind)
  return { ...base, type: 'document', ...item, ...(systemKind ? { systemKind } : {}) }
}
