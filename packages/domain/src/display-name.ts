// The name in a display name as sources write it: without what mail clients, directories and
// subjects add around it. Pure and linear in the name (a name of a source may be 1,000
// characters of anything).

/** The legal form of a company at the end of a display name («Acme S.p.A.», «Contoso Ltd»). */
export const COMPANY_FORM =
  /(?:^|[\s.])(?:s\.?\s?p\.?\s?a|s\.?\s?r\.?\s?l(?:\.?\s?s)?|s\.?\s?a\.?\s?s|s\.?\s?n\.?\s?c|inc|ltd|llc|gmbh|ag|plc|corp|co|sa|srl|spa|bv|nv)\.?$/iu
/** Most trailing suffixes stripped from one display name. */
const MAX_SUFFIXES = 4

const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c)
/** What separates a name from what a client adds after it: « | », « - », « – », « — ». */
const SUFFIX_MARKS = new Set(['|', '-', '\u2013', '\u2014'])

/** The position of the first suffix mark between spaces, or -1: one pass. */
function suffixMark(text: string): number {
  for (let i = 1; i < text.length - 1; i += 1) {
    if (SUFFIX_MARKS.has(text[i] as string) && isSpace(text[i - 1]) && isSpace(text[i + 1])) {
      return i
    }
  }
  return -1
}

/**
 * The name in a display name, without what mail clients and directories add after it: a
 * trailing «(…)», a « | …», « - …» or « – …» and a «, Acme S.p.A.». Each step is a scan or a
 * pattern anchored at a known place, so the cleanup is linear in the name (a name of a source
 * may be 1,000 characters of anything).
 */
export function displayCore(displayName: string): string {
  let core = displayName.normalize('NFC').trim()
  for (let i = 0; i < MAX_SUFFIXES; i += 1) {
    const before = core
    if (core.endsWith(')')) {
      const open = core.lastIndexOf('(')
      // A bracket of its own: nothing else opens or closes inside it.
      if (open > 0 && core.indexOf(')', open) === core.length - 1) {
        core = core.slice(0, open).trimEnd()
      }
    }
    const mark = suffixMark(core)
    if (mark > 0) core = core.slice(0, mark).trimEnd()
    const comma = core.lastIndexOf(',')
    const tail = comma > 0 ? core.slice(comma + 1).trim() : ''
    if (tail !== '' && tail.length <= 40 && COMPANY_FORM.test(tail)) {
      core = core.slice(0, comma).trimEnd()
    }
    if (core === before) break
  }
  return core
}

/** Most tags in brackets taken off the start of a name («[EXT] [Guest] Mario Rossi»). */
const MAX_TAGS = 4
/** Longest tag in brackets taken off: a longer bracket is not a tag. */
const MAX_TAG = 40

/**
 * A display name without its decorations: tags in brackets at its start («[EXT]»), an address in
 * angle brackets at its end («<m.rossi@acme.it>»). One pass each. Digits stay: a name of a member
 * may hold them («Luca99»); the judgement of what is a person reads letters only.
 */
export function undecorated(displayName: string): string {
  let name = displayName.normalize('NFC').trim()
  for (let i = 0; i < MAX_TAGS && name.startsWith('['); i += 1) {
    const close = name.indexOf(']')
    if (close < 0 || close > MAX_TAG) break
    name = name.slice(close + 1).trimStart()
  }
  const open = name.lastIndexOf('<')
  if (open >= 0 && name.endsWith('>')) name = name.slice(0, open).trimEnd()
  return name
}

/** The name of a person as written, without decorations nor what clients add after it. */
export function personNameCore(displayName: string): string {
  return displayCore(undecorated(displayName))
}

/** Longest piece of a name looked at (a longer one is not a name). */
const MAX_SEGMENT = 200

/**
 * The pieces of a display name: the text of each bracket and parenthesis, and the pieces between
 * the marks clients put around a name (« - », « | », «, », «/», «;»), without an address in angle
 * brackets. «Helpdesk - Mario Rossi» gives «Helpdesk» and «Mario Rossi»; «Support (Mario
 * Rossi)» gives «Mario Rossi» and «Support». Linear in the name.
 */
export function nameSegments(displayName: string): string[] {
  const name = displayName.normalize('NFC').replace(/<[^<>]{0,320}>/gu, ' ')
  const out: string[] = []
  for (const m of name.matchAll(/[[(]([^[\]()]{1,200})[\])]/gu)) out.push((m[1] as string).trim())
  const flat = name.replace(/[[\]()]/gu, ' | ')
  for (const piece of flat.split(/\s[-–—|]\s|[,/;|]/u)) {
    const trimmed = piece.replace(/\s+/gu, ' ').trim()
    if (trimmed !== '' && trimmed.length <= MAX_SEGMENT) out.push(trimmed)
  }
  return [...new Set(out.filter((x) => x !== '' && x.length <= MAX_SEGMENT))]
}
