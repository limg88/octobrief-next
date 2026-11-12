/**
 * The first `max` UTF-16 units of a text, never half a character: a cut inside a surrogate pair
 * drops the half. What a connector scans of a field from the source is capped so, first.
 */
export function headOf(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, max)
  return /[\uD800-\uDBFF]/.test(head.at(-1) ?? '') ? head.slice(0, -1) : head
}

/** The first `max` characters (code points) of a text: a surrogate pair is never split. */
export function cutToCharacters(value: string, max: number): string {
  let units = 0
  let count = 0
  for (const c of value) {
    if (count === max) return value.slice(0, units)
    units += c.length
    count += 1
  }
  return value
}

/** Spaces folded within each line, runs of empty lines made one, trimmed, in NFC. */
export function tidyLines(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim()
    .normalize('NFC')
}
