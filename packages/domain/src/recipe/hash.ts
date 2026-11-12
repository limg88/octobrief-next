import { createHash } from 'node:crypto'
import type { ContentHash } from '../pseudonym.ts'
import type { Recipe } from './format.ts'

/**
 * The canonical JSON of a value: object keys in code-point order, strings (keys too) in NFC,
 * `undefined` properties left out, arrays in their order. Two values that differ only in the
 * order of their keys or in the Unicode form of their texts have the same canonical JSON.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/**
 * Code-point order (the byte order of UTF-8, as the database sorts with COLLATE "C"), not the
 * UTF-16 order of `<`, which puts a character beyond U+FFFF before U+E000…U+FFFF.
 */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d !== 0) return d
  }
  return x.length - y.length
}

function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC')
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)))
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.normalize('NFC'), canonical(v)] as const)
      .sort(([a], [b]) => byCodePoint(a, b))
    // Two keys that are the same text in NFC would leave one value out: no canonical form.
    if (new Set(entries.map(([k]) => k)).size !== entries.length) {
      throw new Error('canonicalJson: two keys are the same text')
    }
    return Object.fromEntries(entries)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('canonicalJson: a number that is not finite has no canonical form')
  }
  return value
}

/** SHA-256 of the canonical JSON of a value. */
export function canonicalHash(value: unknown): ContentHash {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}` as ContentHash
}

/** The fingerprint of a recipe: the hash of its canonical form. */
export function recipeHash(recipe: Recipe): ContentHash {
  return canonicalHash(recipe)
}
