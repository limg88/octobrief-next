import { headOf, tidyLines } from './text.ts'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** The longest HTML read by default, in UTF-16 units: the rest is not looked at. */
export const MAX_DESCRIPTION_HTML = 64 * 1024

/** Closing tags (and `<br>`) that end a line of text. */
const LINE_ENDS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
])
/** Elements whose content is never text. */
const RAW = new Set(['script', 'style'])
/** People mentioned in one HTML field kept at most, and the longest name of one. */
export const MAX_HTML_MENTIONS = 50
const MAX_MENTION_NAME = 200
/** The attribute Azure DevOps marks a mention of a person with (`<a data-vss-mention=…>`). */
const MENTION_ATTRIBUTE = /\sdata-vss-mention\s*=/i

const isNameChar = (c: string) => /[A-Za-z0-9]/.test(c)

/** The position after the closing tag of a raw element (`</script…>`), or -1 when there is none. */
function endOfRaw(src: string, from: number, name: string): number {
  let at = from
  for (;;) {
    const open = src.indexOf('</', at)
    if (open === -1) return -1
    const candidate = src.slice(open + 2, open + 2 + name.length)
    if (candidate.toLowerCase() === name && !isNameChar(src[open + 2 + name.length] ?? '')) {
      const close = src.indexOf('>', open)
      return close === -1 ? -1 : close + 1
    }
    at = open + 2
  }
}

/** Whether `<` at `at` opens markup: a tag (a letter, `/`), a comment or declaration (`!`, `?`). */
const opensMarkup = (src: string, at: number) => /[A-Za-z/!?]/.test(src[at + 1] ?? '')

/**
 * Where a quote is known never to close: a quote of that kind opened at or after this position
 * has no closing one before the end (a scan from there reached the end). Kept for the whole
 * input, so each kind of quote is scanned to the end at most once.
 */
type Unclosed = Record<'"' | "'", number>

/**
 * The position of the `>` that ends the tag opened at `lt`, or -1 when there is none: a `>`
 * inside a quoted attribute value (`title="a>b"`) is part of the tag. A quote opens a value only
 * after `=`. A quote that never closes is not a value: the tag ends at its first `>`.
 */
function endOfTag(src: string, lt: number, unclosed: Unclosed): number {
  let quote: '"' | "'" | '' = ''
  let opened = -1
  let afterEquals = false
  for (let i = lt + 1; i < src.length; i += 1) {
    const c = src[i] as string
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '>') return i
    if ((c === '"' || c === "'") && afterEquals) {
      if (i >= unclosed[c]) return src.indexOf('>', lt + 1)
      quote = c
      opened = i
    }
    if (c === '=') afterEquals = true
    else if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') afterEquals = false
  }
  if (quote === '') return -1
  unclosed[quote] = Math.min(unclosed[quote], opened)
  return src.indexOf('>', lt + 1)
}

/**
 * Drops the markup in one pass, each character looked at a bounded number of times: tags and
 * comments go, the content of scripts and styles goes, `<br>` and the end of a block become a
 * line break. A `<` that opens no markup (`a < b`, `<5`) is text; so is the rest after a tag
 * that never closes. What follows a comment or script that never closes is dropped.
 */
function stripTags(src: string, mentions?: string[]): string {
  const parts: string[] = []
  // Where the text of an open mention link starts in `parts`, or -1 outside one.
  let mentionFrom = -1
  const unclosed: Unclosed = { '"': Number.POSITIVE_INFINITY, "'": Number.POSITIVE_INFINITY }
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      parts.push(src.slice(i))
      break
    }
    parts.push(src.slice(i, lt))
    if (!opensMarkup(src, lt)) {
      parts.push('<')
      i = lt + 1
      continue
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    const gt = endOfTag(src, lt, unclosed)
    if (gt === -1) {
      parts.push(src.slice(lt))
      break
    }
    const closing = src[lt + 1] === '/'
    let nameEnd = lt + (closing ? 2 : 1)
    while (nameEnd < gt && isNameChar(src[nameEnd] as string)) nameEnd += 1
    const name = src.slice(lt + (closing ? 2 : 1), nameEnd).toLowerCase()
    if (mentions && name === 'a') {
      if (!closing && MENTION_ATTRIBUTE.test(src.slice(nameEnd, gt))) mentionFrom = parts.length
      else if (closing && mentionFrom !== -1) {
        // Bounded by the HTML read: every mention is kept, so that one too many is known.
        mentions.push(parts.slice(mentionFrom).join(''))
        mentionFrom = -1
      }
    }
    i = gt + 1
    if (!closing && RAW.has(name)) {
      const end = endOfRaw(src, i, name)
      if (end === -1) break
      i = end
      parts.push(' ')
    } else if (name === 'br' || (closing && LINE_ENDS.has(name))) {
      parts.push('\n')
    }
  }
  return parts.join('')
}

/**
 * The text of an HTML field: at most the first `maxHtml` units read (64 KiB by default), tags dropped, blocks as lines,
 * entities decoded, spaces folded. Linear in the input.
 */
export function htmlToText(html: string, maxHtml: number = MAX_DESCRIPTION_HTML): string {
  return tidyLines(decodeEntities(stripTags(headOf(html, maxHtml))))
}

/**
 * The text of an HTML field (`htmlToText`) and the names of the people its mention links name
 * (`<a data-vss-mention=…>@Nome</a>`), without the «@»; `mentionsRefused` (and no names) when
 * there are more than `MAX_HTML_MENTIONS` or one is too long to be a name: the item is then left
 * out. Linear in the input, like the text.
 */
export function htmlTextAndMentions(
  html: string,
  maxHtml: number = MAX_DESCRIPTION_HTML,
): { text: string; mentions: string[]; mentionsRefused: boolean } {
  const raw: string[] = []
  const text = tidyLines(decodeEntities(stripTags(headOf(html, maxHtml), raw)))
  const names = [
    ...new Set(
      raw
        .map((m) => tidyLines(decodeEntities(m)).replace(/\s+/gu, ' ').replace(/^@+/, '').trim())
        .filter((m) => m !== ''),
    ),
  ]
  const mentionsRefused =
    names.length > MAX_HTML_MENTIONS || names.some((m) => m.length > MAX_MENTION_NAME)
  return { text, mentions: mentionsRefused ? [] : names, mentionsRefused }
}

/** The character references of a text decoded; an unknown named one is kept as written. */
function decodeEntities(withBreaks: string): string {
  return withBreaks.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : ' '
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}
