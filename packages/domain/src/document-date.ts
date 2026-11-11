import { type Lang, vocabulary } from './language/index.ts'
import { isCalendarDate, romeMidnight } from './rome-time.ts'

/**
 * Where the date of a document comes from, from the strongest to the weakest: the PM, the source
 * system (for a transcript, the meeting date its own header gives), the file name, the document
 * metadata, the date the file was last changed on the disk, the acquisition.
 */
export const DATE_SOURCES = [
  'pm',
  'system',
  'file_name',
  'metadata',
  'file_modified',
  'acquisition',
] as const
export type DateSource = (typeof DATE_SOURCES)[number]

export interface DocumentDate {
  date: Date
  source: DateSource
}

export interface DocumentDateInput {
  /** The date the PM gave for this document, if any. */
  pmDate?: Date
  /** The date the source system gave for this item (a connector read it), if any. */
  systemDate?: Date
  fileName: string
  /** Date found in the document metadata, if any. */
  metadataDate: Date | null
  /** The date the file was last changed where it was read (a folder on the disk), if any. */
  fileModifiedDate?: Date | null
  acquiredAt: Date
  lang: Lang
}

const EARLIEST = romeMidnight(1990, 1, 1).getTime()
const DAY_MS = 24 * 60 * 60 * 1000
/** A file name longer than this is not scanned beyond it (names are at most 255 characters). */
const MAX_NAME = 300

// Each pattern is a single linear pass: fixed-size digit groups, no nested repetition.
const YEAR_FIRST = /(?<!\d)(\d{4})([-_.])(\d{2})\2(\d{2})(?!\d)/g
const COMPACT = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g
const DAY_FIRST = /(?<!\d)(\d{1,2})[-._](\d{1,2})[-._](\d{4})(?!\d)/g
const DAY_MONTH_NAME =
  /(?<![\p{L}\d])(\d{1,2})[°º]?[ _-]{1,3}(\p{L}{3,9})\.?[ _-]{1,3}(\d{4})(?!\d)/gu
/** Day, month written in full and year without separators: «3Giugno2026», «25september2026». */
const DAY_MONTH_NAME_JOINED = /(?<![\p{L}\d])(\d{1,2})(\p{L}{3,9})(\d{4})(?!\d)/gu

/** English month names written in full: a file name may be in English whatever the language. */
const ENGLISH_MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
}

/** The month of a name: of the language (abbreviations too) or English, in full. */
function monthOf(word: string, lang: Lang): number | undefined {
  const w = word.toLowerCase()
  return vocabulary(lang).MONTHS[w] ?? ENGLISH_MONTHS[w]
}

/** The month of a name written in full only (no abbreviation): what a joined date needs. */
function fullMonthOf(word: string, lang: Lang): number | undefined {
  const w = word.toLowerCase()
  const index = vocabulary(lang).FULL_MONTHS.indexOf(w)
  return index >= 0 ? index + 1 : ENGLISH_MONTHS[w]
}

/** Plausible: from 1990 up to the day after acquisition (clocks and time zones). */
function isPlausible(instant: Date, acquiredAt: Date): boolean {
  const t = instant.getTime()
  return Number.isFinite(t) && t >= EARLIEST && t <= acquiredAt.getTime() + DAY_MS
}

/**
 * The date a source system declares for an item (when it was made or changed, or up to when it
 * was read), as a date of origin. A date further ahead than the clocks can explain is not one —
 * a due date or a plan, never the time of the read — and is left not deduced, like one before
 * 1990 or a value that is no date. One ahead by less than a day is the time of the read.
 */
export function sourceDeclaredDate(value: unknown, readAt: Date): Date | null {
  if (!(value instanceof Date) || !isPlausible(value, readAt)) return null
  return value.getTime() > readAt.getTime() ? new Date(readAt.getTime()) : value
}

function fromParts(y: number, m: number, d: number, acquiredAt: Date): Date | null {
  if (!isCalendarDate(y, m, d)) return null
  const date = romeMidnight(y, m, d)
  return isPlausible(date, acquiredAt) ? date : null
}

/** The distinct plausible calendar dates written in a file name. */
function datesInName(name: string, acquiredAt: Date, lang: Lang): Date[] {
  const text = name.slice(0, MAX_NAME)
  const found = new Map<number, Date>()
  const add = (date: Date | null) => {
    if (date) found.set(date.getTime(), date)
  }
  for (const m of text.matchAll(YEAR_FIRST)) {
    add(fromParts(Number(m[1]), Number(m[3]), Number(m[4]), acquiredAt))
  }
  for (const m of text.matchAll(COMPACT)) {
    add(fromParts(Number(m[1]), Number(m[2]), Number(m[3]), acquiredAt))
  }
  for (const m of text.matchAll(DAY_FIRST)) {
    add(fromParts(Number(m[3]), Number(m[2]), Number(m[1]), acquiredAt))
  }
  for (const m of text.matchAll(DAY_MONTH_NAME)) {
    const month = monthOf(m[2] as string, lang)
    if (month !== undefined) add(fromParts(Number(m[3]), month, Number(m[1]), acquiredAt))
  }
  for (const m of text.matchAll(DAY_MONTH_NAME_JOINED)) {
    const month = fullMonthOf(m[2] as string, lang)
    if (month !== undefined) add(fromParts(Number(m[3]), month, Number(m[1]), acquiredAt))
  }
  return [...found.values()]
}

/**
 * The date of a document, in order of precedence: given by the PM, given by the source system a
 * connector read it from (only if plausible), written in the file name,
 * found in the document metadata (only if plausible), the date the file was last changed on the
 * disk (only if plausible, declared as such), otherwise the acquisition, declared as such.
 * Never read from the free text of the document (a transcript's meeting header is read apart, by
 * `meetingDateInText`, and comes as the system's date).
 *
 * Dates in names are day-first (Italian). When the name holds two different plausible dates
 * (e.g. «SAL 2026-10-31 vs 2026-09-30»), the name gives no choice: the document does not say which
 * one is its own, and picking one would be a guess; the next source is used.
 */
export function documentDate(input: DocumentDateInput): DocumentDate {
  if (input.pmDate) return { date: input.pmDate, source: 'pm' }
  if (input.systemDate && isPlausible(input.systemDate, input.acquiredAt)) {
    return { date: input.systemDate, source: 'system' }
  }
  const named = datesInName(input.fileName, input.acquiredAt, input.lang)
  if (named.length === 1) return { date: named[0] as Date, source: 'file_name' }
  if (input.metadataDate && isPlausible(input.metadataDate, input.acquiredAt)) {
    return { date: input.metadataDate, source: 'metadata' }
  }
  if (input.fileModifiedDate && isPlausible(input.fileModifiedDate, input.acquiredAt)) {
    return { date: input.fileModifiedDate, source: 'file_modified' }
  }
  return { date: input.acquiredAt, source: 'acquisition' }
}

/**
 * The one date of a piece of evidence, wherever it is used (the knowledge card, the freshness, «a
 * newer document of the same kind», the compile window): its current classification's, else its
 * date at the source, declared by who gave it (the PM, the system or the acquisition).
 */
export function evidenceDate(
  evidence: { originAt: Date; originSource: 'pm' | 'system' | 'acquisition' },
  classified: DocumentDate | null,
): DocumentDate {
  return classified ?? { date: evidence.originAt, source: evidence.originSource }
}

/** Whether a date from `candidate` is better than one from `current` (strictly stronger source). */
export function strongerDateSource(candidate: DateSource, current: DateSource): boolean {
  return DATE_SOURCES.indexOf(candidate) < DATE_SOURCES.indexOf(current)
}

/**
 * The date a document is dated again with, or null when it keeps its own: only a strictly better
 * source replaces the current one, and never a date the PM gave.
 */
export function redated(current: DocumentDate, found: DocumentDate): DocumentDate | null {
  if (current.source === 'pm') return null
  return strongerDateSource(found.source, current.source) ? found : null
}

/** How sure the date of a document is: a weak date never makes a relative time absolute. */
export function isCertainDate(source: DateSource): boolean {
  return source === 'pm' || source === 'system' || source === 'file_name' || source === 'metadata'
}

/** Lines of a transcript read for its header: the title, the date, the duration come first. */
const HEADER_LINES = 6
/** A header line is short: a longer line is text, never the header. */
const MAX_HEADER_LINE = 80
const TIME = String.raw`(?:,?\s*(?:alle\s+)?\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?`
const DAY_MONTH_YEAR = new RegExp(
  String.raw`^(\d{1,2})[°º]?\s+(\p{L}{3,9})\.?\s+(\d{4})${TIME}$`,
  'u',
)
const MONTH_DAY_YEAR = new RegExp(String.raw`^(\p{L}{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})${TIME}$`, 'u')
/** The length of the recording on the line after the date: «45m 3s», «1h 2m», «1 h 5 min 3 s». */
const DURATION =
  /^(?:\d{1,2}\s?h(?:\s?\d{1,2}\s?m(?:in)?)?(?:\s?\d{1,2}\s?s)?|\d{1,3}\s?m(?:in)?(?:\s?\d{1,2}\s?s)?|\d{1,2}\s?s)$/

/**
 * The meeting date a transcript's own header gives, or null: a line that is only a date (with
 * its time, maybe) followed by a line that is only the length of the recording, among the first
 * lines, as Teams writes the transcripts it saves. A date anywhere else in the text is never
 * taken: it may be any day the meeting talked about.
 */
export function meetingDateInText(text: string, lang: Lang): Date | null {
  const lines: string[] = []
  for (const raw of text.slice(0, HEADER_LINES * MAX_HEADER_LINE * 4).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    lines.push(line)
    if (lines.length >= HEADER_LINES) break
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const line = lines[i] as string
    const next = lines[i + 1] as string
    if (line.length > MAX_HEADER_LINE || !DURATION.test(next)) continue
    let parts: [number, number | undefined, number] | null = null
    const dmy = DAY_MONTH_YEAR.exec(line)
    if (dmy) parts = [Number(dmy[3]), monthOf(dmy[2] as string, lang), Number(dmy[1])]
    const mdy = parts ? null : MONTH_DAY_YEAR.exec(line)
    if (mdy) parts = [Number(mdy[3]), monthOf(mdy[1] as string, lang), Number(mdy[2])]
    if (!parts || parts[1] === undefined) continue
    const [y, m, d] = parts
    if (isCalendarDate(y, m, d)) return romeMidnight(y, m, d)
  }
  return null
}
