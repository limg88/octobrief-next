/** The only methods a rule may allow: reads. POST only where an API reads with it (a query). */
export const READ_METHODS = ['GET', 'HEAD', 'POST'] as const
export type ReadMethod = (typeof READ_METHODS)[number]

/**
 * One segment of an allowed path: a literal compared exactly with the decoded segment (a value
 * from the configuration goes here as it is, never as a pattern), or `'segment'`, any one
 * non-empty segment (an id). A literal is in composed Unicode form (NFC): a connector normalizes
 * a name before it builds a rule or a URL from it.
 */
export type PathPart = { literal: string } | 'segment'

/**
 * One call a connector may make. No pattern is ever supplied: the host is a literal host name
 * (`[a-z0-9.-]`, optionally `:port`), the path a list of parts matched segment by segment, and
 * `rest` lets any further segments follow, only after at least two literal segments. The query
 * string is not part of the match.
 */
export interface HttpRule {
  method: ReadMethod
  host: string
  path: readonly PathPart[]
  rest?: true
}

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::(\d{1,5}))?$/
const ENCODED_SEPARATOR = /%2f|%5c|%2e/i

function validLiteral(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value !== '.' &&
    value !== '..' &&
    value === value.normalize('NFC') &&
    !/[/\\?#]/.test(value) &&
    ![...value].some((c) => (c.codePointAt(0) ?? 0) < 0x20)
  )
}

/** Checks a rule when the client is made; a rule that could allow more than it says throws. */
export function checkRule(rule: HttpRule): HttpRule {
  if (!(READ_METHODS as readonly string[]).includes(rule.method)) {
    throw new TypeError('a connector rule allows reads only')
  }
  const host = typeof rule.host === 'string' ? HOST.exec(rule.host) : null
  if (!host) throw new TypeError('a connector rule names a literal host')
  if (host[1] !== undefined) {
    const port = Number(host[1])
    if (port < 1 || port > 65535) throw new TypeError('a connector rule port is 1 to 65535')
    // A URL never carries the default port of its scheme: such a rule could never match.
    if (port === 443 || port === 80) {
      throw new TypeError('a connector rule names no default port (443, 80)')
    }
  }
  if (!Array.isArray(rule.path) || rule.path.length === 0) {
    throw new TypeError('a connector rule has a path')
  }
  let literals = 0
  for (const part of rule.path) {
    if (part === 'segment') continue
    if (typeof part !== 'object' || part === null || !validLiteral(part.literal)) {
      throw new TypeError('a connector rule path segment is a plain literal')
    }
    literals += 1
  }
  if (rule.rest !== undefined && (rule.rest !== true || literals < 2)) {
    throw new TypeError('a connector rule allows a rest only after two literal segments')
  }
  const path = rule.path.map((p) => (p === 'segment' ? p : { literal: p.literal }))
  return Object.freeze({ ...rule, path: Object.freeze(path) })
}

/**
 * The decoded segments of a path, or null when it holds encoded separators, bad escapes or a
 * segment not in composed Unicode form (NFC). The decision is taken on the very bytes that are
 * sent: a decomposed segment is refused, never normalized, so the server cannot read a path
 * other than the one allowed.
 */
export function segmentsOf(pathname: string): string[] | null {
  if (ENCODED_SEPARATOR.test(pathname) || !pathname.startsWith('/')) return null
  let segments: string[]
  try {
    // Split first, then decode: an encoded percent (%25) stays text and never becomes a slash.
    segments = pathname.slice(1).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  return segments.every((s) => s === s.normalize('NFC')) ? segments : null
}

/** Whether the rule's path allows these segments. */
export function pathAllowed(rule: HttpRule, segments: readonly string[]): boolean {
  if (segments.length < rule.path.length) return false
  if (segments.length > rule.path.length && !rule.rest) return false
  for (const [i, part] of rule.path.entries()) {
    const segment = segments[i] as string
    if (part === 'segment') {
      if (segment === '' || segment === '.' || segment === '..') return false
    } else if (segment !== part.literal) {
      return false
    }
  }
  return segments.slice(rule.path.length).every((s) => s !== '.' && s !== '..')
}

/** Whether any of the rules allows this call (method, host and path; never the query). */
export function rulesAllow(rules: readonly HttpRule[], method: string, url: URL): boolean {
  const segments = segmentsOf(url.pathname)
  if (segments === null) return false
  return rules.some(
    (r) =>
      r.method === method.toUpperCase() &&
      r.host === url.host.toLowerCase() &&
      pathAllowed(r, segments),
  )
}
