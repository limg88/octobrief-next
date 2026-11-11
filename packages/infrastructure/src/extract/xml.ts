/**
 * A deliberately small XML scan for the Office parts we read. It never builds a document and
 * never resolves entities declared in a DTD: only the five predefined ones and numeric character
 * references are decoded, anything else stays as written. Every scan is a single forward pass
 * over the text (`indexOf`, no backtracking), so hostile input costs time proportional to its
 * size; an unterminated tag simply ends the scan.
 */

const decoder = new TextDecoder('utf-8')

const escapeText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * Comments are dropped and CDATA sections become escaped text, so that what is left is plain
 * markup and text. An unterminated comment drops the rest; an unterminated CDATA runs to the end.
 */
function stripCommentsAndCdata(xml: string): string {
  let at = xml.indexOf('<!')
  if (at < 0) return xml
  const parts: string[] = []
  let from = 0
  while (at >= 0) {
    if (xml.startsWith('<!--', at)) {
      parts.push(xml.slice(from, at))
      const end = xml.indexOf('-->', at + 4)
      if (end < 0) return parts.join('')
      from = end + 3
    } else if (xml.startsWith('<![CDATA[', at)) {
      parts.push(xml.slice(from, at))
      const end = xml.indexOf(']]>', at + 9)
      if (end < 0) {
        parts.push(escapeText(xml.slice(at + 9)))
        return parts.join('')
      }
      parts.push(escapeText(xml.slice(at + 9, end)))
      from = end + 3
    }
    at = xml.indexOf('<!', at + 2)
  }
  parts.push(xml.slice(from))
  return parts.join('')
}

/** UTF-8 text of an XML part, ready for the scans below. */
export function decodeXml(bytes: Uint8Array): string {
  return stripCommentsAndCdata(decoder.decode(bytes))
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole
      // A lone surrogate is not a character: it would corrupt the text.
      return code >= 0xd800 && code <= 0xdfff ? '�' : String.fromCodePoint(code)
    }
    return NAMED[body] ?? whole
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const isTagEnd = (char: string | undefined): boolean =>
  char === '>' || char === '/' || char === ' ' || char === '\n' || char === '\t' || char === '\r'

/** Index of the next `<tag` that is a whole tag name (not `<tagged`), from `from`; -1 if none. */
function nextOpen(xml: string, open: string, from: number): number {
  let at = xml.indexOf(open, from)
  while (at >= 0 && !isTagEnd(xml[at + open.length])) at = xml.indexOf(open, at + 1)
  return at
}

/**
 * Outermost elements named `tag` (prefix included, e.g. `w:p`) with their attribute text and inner
 * XML. Same-name elements nested inside one are part of its body, not elements of their own;
 * self-closed ones have an empty body. An unterminated element ends the scan.
 */
export function elements(xml: string, tag: string): { attrs: string; body: string }[] {
  const open = `<${tag}`
  const close = `</${tag}>`
  const found: { attrs: string; body: string }[] = []
  let pos = 0
  for (;;) {
    const start = nextOpen(xml, open, pos)
    if (start < 0) break
    const gt = xml.indexOf('>', start + open.length)
    if (gt < 0) break
    const attrs = xml.slice(start + open.length, gt)
    if (attrs.endsWith('/')) {
      found.push({ attrs: attrs.slice(0, -1), body: '' })
      pos = gt + 1
      continue
    }
    // Find the matching close tag, counting nested elements of the same name.
    let depth = 1
    let nextO = nextOpen(xml, open, gt + 1)
    let nextC = xml.indexOf(close, gt + 1)
    let end = -1
    if (nextO < 0) nextO = Number.POSITIVE_INFINITY
    while (nextC >= 0) {
      if (nextO < nextC) {
        const nestedGt = xml.indexOf('>', nextO + open.length)
        if (nestedGt < 0) {
          nextO = Number.POSITIVE_INFINITY
          continue
        }
        if (xml[nestedGt - 1] !== '/') depth++
        const after = nextOpen(xml, open, nestedGt + 1)
        nextO = after < 0 ? Number.POSITIVE_INFINITY : after
      } else {
        depth--
        if (depth === 0) {
          end = nextC
          break
        }
        const resume = nextC + close.length
        nextC = xml.indexOf(close, resume)
        if (nextO < resume) {
          const after = nextOpen(xml, open, resume)
          nextO = after < 0 ? Number.POSITIVE_INFINITY : after
        }
      }
    }
    if (end < 0) break
    found.push({ attrs, body: xml.slice(gt + 1, end) })
    pos = end + close.length
  }
  return found
}

/** The text with every element named `tag` removed (an unterminated one removes the rest). */
export function removeElements(xml: string, tag: string): string {
  const open = `<${tag}`
  const close = `</${tag}>`
  const parts: string[] = []
  let pos = 0
  for (;;) {
    const start = nextOpen(xml, open, pos)
    if (start < 0) break
    parts.push(xml.slice(pos, start))
    const gt = xml.indexOf('>', start + open.length)
    if (gt < 0) return parts.join('')
    if (xml[gt - 1] === '/') {
      pos = gt + 1
      continue
    }
    const end = xml.indexOf(close, gt + 1)
    if (end < 0) return parts.join('')
    pos = end + close.length
  }
  parts.push(xml.slice(pos))
  return parts.join('')
}

/** Attribute text of every tag of that name, self-closed or not (a tag never closed ends it). */
export function tags(xml: string, tag: string): string[] {
  const open = `<${tag}`
  const found: string[] = []
  let pos = 0
  for (;;) {
    const start = nextOpen(xml, open, pos)
    if (start < 0) break
    const gt = xml.indexOf('>', start + open.length)
    if (gt < 0) break
    found.push(xml.slice(start + open.length, gt).replace(/\/$/, ''))
    pos = gt + 1
  }
  return found
}

export function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  const value = m?.[1] ?? m?.[2]
  return value === undefined ? undefined : decodeEntities(value)
}

/**
 * The decoded text of the `textTag` elements inside `xml`, in document order, with each element
 * named in `marks` written as its character: a line break, a tab. A Word paragraph such as
 * «Speaker 0:03<w:br/>Buongiorno» reads as «Speaker 0:03\nBuongiorno», never with the words
 * glued. One forward pass; an unterminated text element ends the scan.
 */
export function inlineTextOf(
  xml: string,
  textTag: string,
  marks: Readonly<Record<string, string>>,
): string {
  const close = `</${textTag}>`
  let out = ''
  let pos = 0
  for (;;) {
    const lt = xml.indexOf('<', pos)
    if (lt < 0) break
    const gt = xml.indexOf('>', lt + 1)
    if (gt < 0) break
    const inside = xml.slice(lt + 1, gt)
    const name = inside.split(/[\s/]/, 1)[0] ?? ''
    pos = gt + 1
    if (name === textTag) {
      if (inside.endsWith('/')) continue
      const end = xml.indexOf(close, pos)
      if (end < 0) break
      out += decodeEntities(xml.slice(pos, end))
      pos = end + close.length
    } else if (Object.hasOwn(marks, name)) out += marks[name]
  }
  return out
}

/** Concatenated, decoded text of the `<tag>` elements inside `xml` (e.g. `w:t`, `a:t`). */
export function textOf(xml: string, tag: string): string {
  return elements(xml, tag)
    .map((e) => decodeEntities(e.body))
    .join('')
}

/** `dcterms:modified`, else `dcterms:created`, from docProps/core.xml. */
export function officeMetadataDate(
  core: Uint8Array | undefined,
  order: readonly string[] = ['dcterms:modified', 'dcterms:created'],
): Date | null {
  if (!core) return null
  const xml = decodeXml(core)
  for (const tag of order) {
    const value = elements(xml, tag)[0]?.body.trim()
    if (value) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date
    }
  }
  return null
}
