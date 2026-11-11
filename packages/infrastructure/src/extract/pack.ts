import { CHUNK_CHARS } from './limits.ts'

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * Splits a long string into pieces of at most `max` characters, preferring to cut at a space and
 * never inside a surrogate pair.
 */
export function splitLong(text: string, max = CHUNK_CHARS): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) {
      cut = max
      // Never leave a high surrogate ending a piece with its low half starting the next.
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--
    }
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

export interface Unit<T> {
  /** Where the unit is; the group keeps the place of its first and of its last unit. */
  at: T
  text: string
}

export interface Group<T> {
  first: T
  last: T
  text: string
}

/**
 * Groups consecutive units, joined by a newline, up to `max` characters per group. A unit longer
 * than `max` is split on its own and each piece becomes a group of its own.
 */
export function pack<T>(units: Iterable<Unit<T>>, max = CHUNK_CHARS): Group<T>[] {
  const groups: Group<T>[] = []
  let current: Group<T> | undefined
  for (const unit of units) {
    if (unit.text.length > max) {
      current = undefined
      for (const piece of splitLong(unit.text, max)) {
        groups.push({ first: unit.at, last: unit.at, text: piece })
      }
      continue
    }
    if (current && current.text.length + 1 + unit.text.length <= max) {
      current.text += `\n${unit.text}`
      current.last = unit.at
    } else {
      current = { first: unit.at, last: unit.at, text: unit.text }
      groups.push(current)
    }
  }
  return groups
}
