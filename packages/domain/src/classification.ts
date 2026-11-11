import { type DocumentDate, documentDate } from './document-date.ts'
import { type Lang, vocabulary } from './language/index.ts'

export const AUDIENCES = ['internal', 'client'] as const
export type Audience = (typeof AUDIENCES)[number]

export const DOCUMENT_KINDS = [
  'status_report',
  'meeting_minutes',
  'transcript',
  'contract',
  'contract_deliverables',
  'purchase_order',
  'invoice',
  'timesheet',
  'backlog_export',
  'economics_export',
  'presentation',
  'generic',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/**
 * Whether a document of this kind is internal whatever anyone says: an economics export (costs,
 * revenue, margins, rates) always; a timesheet when a source system gave it (hours and costs per
 * person). Never for the client, not even by the PM's choice.
 *
 * This is the audience of the evidence as a document, and the client version of a deliverable
 * does not change it: the projection for the client (`projectClientVersion`) is a separate
 * layer, which may let through single values of an internal extraction by their category (the
 * ordered and invoiced amounts of the data warehouse) with a generic source note, and never the
 * extraction itself, its title or its free text.
 */
export function isInternalOnly(kind: DocumentKind, fromSystem = false): boolean {
  return kind === 'economics_export' || (fromSystem && kind === 'timesheet')
}

export const UNCERTAIN_FIELDS = ['kind', 'audience', 'date'] as const
export type Uncertain = (typeof UNCERTAIN_FIELDS)[number]

export interface Classification {
  kind: DocumentKind
  audience: Audience
  audienceSource: 'pm' | 'rule' | 'default'
  dateOf: DocumentDate
  uncertain: Uncertain[]
}

export interface ClassifyInput {
  fileName: string
  mediaType: string
  /** The first lines of the document; only the first 2,000 characters are read. */
  text: string
  lang: Lang
  /** What the PM decided; each field wins over any rule. */
  pm?: Partial<{ kind: DocumentKind; audience: Audience; date: Date }>
  /** The date the source system gave, for evidence a connector read. */
  systemDate?: Date
  /**
   * The kind of a document a connector made from a source system (an export of the backlog):
   * it is the kind, after the PM's, and the document is internal by rule.
   */
  systemKind?: DocumentKind
  metadataDate: Date | null
  /** The date the file was last changed where a connector read it (a folder), if any. */
  fileModifiedDate?: Date | null
  acquiredAt: Date
}

const TEXT_WINDOW = 2_000

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const matchers = new Map<string, RegExp>()

/** Whole-word search (letters and digits bound a word; `_`, `-` and spaces separate). */
function hasWord(haystack: string, keyword: string): boolean {
  let re = matchers.get(keyword)
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(keyword)}(?![\\p{L}\\d])`, 'u')
    matchers.set(keyword, re)
  }
  return re.test(haystack)
}

function vetoed(haystack: string, keyword: string, vocab: ReturnType<typeof vocabulary>) {
  return vocab.KEYWORD_VETOES[keyword]?.test(haystack) ?? false
}

/**
 * The kind a title line decides, among the kinds that only a title (or a file name) decides. A
 * title that names an earlier kind first (a «Verbale – ordine X») decides nothing.
 */
function kindOfHeading(text: string, lang: Lang): DocumentKind | null {
  const vocab = vocabulary(lang)
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '')
  if (first === undefined) return null
  const title = first.replace(/^[\s#>*_|-]+/, '').toLowerCase()
  for (const [kind, keywords] of vocab.KIND_KEYWORDS) {
    const hit = keywords.some((k) => hasWord(title, k) && !vetoed(title, k, vocab))
    if (!hit) continue
    return vocab.HEADING_KINDS.includes(kind) ? kind : null
  }
  return null
}

function kindIn(
  haystack: string,
  lang: Lang,
  textOnly: boolean,
): { kind: DocumentKind; weak: boolean } | null {
  const vocab = vocabulary(lang)
  for (const [kind, keywords] of vocab.KIND_KEYWORDS) {
    const usable = textOnly
      ? keywords.filter((k) => !vocab.NAME_ONLY_KEYWORDS.includes(k))
      : keywords
    const found = usable.filter((k) => hasWord(haystack, k) && !vetoed(haystack, k, vocab))
    if (found.length === 0) continue
    // Only a lone bare word of a delivery kind is weak: a phrase, or a second word, is not.
    const weak = found.length === 1 && vocab.WEAK_KEYWORDS.includes(found[0] as string)
    return { kind, weak }
  }
  return null
}

/**
 * Kind, audience and date of a document, by rules alone. The kind is the one a source system
 * gives (`systemKind`), else it comes from the media type, then the file name, then the start of
 * the text. The audience is `client` only on an explicit marker (in the name or a header line
 * «Destinatario: cliente»); otherwise it is `internal`: by rule for a document of a source
 * system, else as the restrictive default, marked uncertain. A field the PM gave is never
 * uncertain.
 */
export function classify(input: ClassifyInput): Classification {
  const vocab = vocabulary(input.lang)
  const uncertain: Uncertain[] = []
  const name = input.fileName.toLowerCase()
  const head = input.text.slice(0, TEXT_WINDOW).toLowerCase()

  let kind: DocumentKind
  if (input.pm?.kind) {
    kind = input.pm.kind
  } else if (input.systemKind) {
    kind = input.systemKind
  } else {
    const byType = input.mediaType.includes(vocab.PRESENTATION_MEDIA_TYPE)
    const byName = byType ? null : kindIn(name, input.lang, false)
    const byText =
      byType || byName
        ? null
        : (kindOfHeading(input.text.slice(0, TEXT_WINDOW), input.lang) ??
          kindIn(head, input.lang, true)?.kind ??
          null)
    kind = byType ? 'presentation' : (byName?.kind ?? byText ?? 'generic')
    // A kind guessed from the start of the text alone, or from a lone bare word of the name, is
    // used, but the PM is asked.
    if (!byType && (!byName || byName.weak)) uncertain.push('kind')
  }

  let audience: Audience
  let audienceSource: Classification['audienceSource']
  if (isInternalOnly(kind, input.systemKind !== undefined && kind === input.systemKind)) {
    // Economics, and the hours of a source system: internal by rule, never for the client.
    audience = 'internal'
    audienceSource = 'rule'
  } else if (input.pm?.audience) {
    audience = input.pm.audience
    audienceSource = 'pm'
  } else if (input.systemKind) {
    // Data of a source system carries estimates and names: never for the client unless the PM
    // decides so, whatever its name or text say.
    audience = 'internal'
    audienceSource = 'rule'
  } else if (
    vocab.INTERNAL_NAME_MARKERS.some((re) => re.test(name)) ||
    vocab.INTERNAL_HEADER_LINE.test(input.text.slice(0, TEXT_WINDOW))
  ) {
    // An explicit internal marker wins over a client marker: the restrictive choice.
    audience = 'internal'
    audienceSource = 'rule'
  } else if (
    vocab.CLIENT_NAME_MARKERS.some((re) => re.test(name)) ||
    vocab.CLIENT_HEADER_LINE.test(input.text.slice(0, TEXT_WINDOW))
  ) {
    audience = 'client'
    audienceSource = 'rule'
  } else {
    audience = 'internal'
    audienceSource = 'default'
    uncertain.push('audience')
  }

  const dateOf = documentDate({
    ...(input.pm?.date ? { pmDate: input.pm.date } : {}),
    ...(input.systemDate ? { systemDate: input.systemDate } : {}),
    fileName: input.fileName,
    metadataDate: input.metadataDate,
    ...(input.fileModifiedDate ? { fileModifiedDate: input.fileModifiedDate } : {}),
    acquiredAt: input.acquiredAt,
    lang: input.lang,
  })
  if (dateOf.source === 'acquisition') uncertain.push('date')

  return { kind, audience, audienceSource, dateOf, uncertain }
}
