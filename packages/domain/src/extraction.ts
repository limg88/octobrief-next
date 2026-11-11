/** Where a piece of extracted text sits in the original document. */
export type Locator =
  | { kind: 'page'; page: number }
  | { kind: 'paragraph'; index: number }
  | { kind: 'slide'; slide: number }
  | { kind: 'cell'; sheet: string; ref: string }
  | { kind: 'line'; from: number; to: number }

export interface TextChunk {
  locator: Locator
  text: string
}

/** Things that can go wrong while extracting; they are recorded, never thrown. */
export type ExtractionWarning =
  | 'no_text'
  | 'encrypted'
  | 'truncated'
  | 'unsupported_format'
  | 'timeout'
  | 'extraction_failed'

export interface Extraction {
  /** Name and version of the extractor: chunks of different versions are never mixed. */
  extractor: string
  chunks: TextChunk[]
  truncated: boolean
  /** Date found in the document metadata, if any (never taken from the free text). */
  metadataDate: Date | null
  /**
   * The creation date the document metadata gives (an Office file's `dcterms:created`), when the
   * format has one: the day a transcript was saved, read before the date the file was changed.
   */
  createdDate?: Date | null
  warnings: ExtractionWarning[]
}

const CELL_REF = /^[A-Z]+[1-9][0-9]*$/

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

/** Whether `value` has the shape of a locator (for data read back from storage). */
export function isLocator(value: unknown): value is Locator {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case 'page':
      return positive(v.page)
    case 'paragraph':
      return positive(v.index)
    case 'slide':
      return positive(v.slide)
    case 'cell':
      return typeof v.sheet === 'string' && typeof v.ref === 'string' && CELL_REF.test(v.ref)
    case 'line':
      return positive(v.from) && positive(v.to) && v.to >= v.from
    default:
      return false
  }
}

/** The locator rebuilt with the fields of its kind only: extra properties never count. */
export function canonicalLocator(locator: Locator): Locator {
  switch (locator.kind) {
    case 'page':
      return { kind: 'page', page: locator.page }
    case 'paragraph':
      return { kind: 'paragraph', index: locator.index }
    case 'slide':
      return { kind: 'slide', slide: locator.slide }
    case 'cell':
      return { kind: 'cell', sheet: locator.sheet, ref: locator.ref }
    case 'line':
      return { kind: 'line', from: locator.from, to: locator.to }
  }
}

/** Stable string identifying a place in a document, e.g. `page:3` or `cell:Budget!B7`. */
export function locatorKey(locator: Locator): string {
  switch (locator.kind) {
    case 'page':
      return `page:${locator.page}`
    case 'paragraph':
      return `paragraph:${locator.index}`
    case 'slide':
      return `slide:${locator.slide}`
    case 'cell':
      return `cell:${locator.sheet}!${locator.ref}`
    case 'line':
      return `line:${locator.from}-${locator.to}`
  }
}
