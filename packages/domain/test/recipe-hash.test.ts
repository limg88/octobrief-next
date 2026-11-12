import { describe, expect, it } from 'vitest'
import { canonicalJson, type Recipe, recipeHash, validateRecipe } from '../src/recipe/index.ts'
import { sampleRecipe } from './support/recipes.ts'

const valid = (input: unknown): Recipe => {
  const v = validateRecipe(input)
  if (!v.ok) throw new Error(JSON.stringify(v.errors))
  return v.recipe
}

/** The same value with the keys of every object in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reversedKeys(v)]),
    )
  }
  return value
}

describe('recipeHash', () => {
  it('gives the same hash to recipes that differ only in key order', () => {
    const a = valid(sampleRecipe())
    const b = reversedKeys(a) as Recipe
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
    expect(recipeHash(a)).toBe(recipeHash(b))
    expect(recipeHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('gives the same hash to texts in different Unicode forms', () => {
    const composed = sampleRecipe()
    composed.purpose = 'Perché il SAL è pronto.'
    const decomposed = sampleRecipe()
    decomposed.purpose = 'Perché il SAL è pronto.'.normalize('NFD')
    expect(recipeHash(valid(composed))).toBe(recipeHash(valid(decomposed)))
  })

  it('changes the hash when the order of the sections changes', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.sections.reverse()
    expect(recipeHash(valid(a))).not.toBe(recipeHash(valid(b)))
  })

  it('writes a canonical JSON without undefined properties', () => {
    expect(canonicalJson({ b: 1, a: [undefined, 'x'], c: undefined })).toBe(
      '{"a":[null,"x"],"b":1}',
    )
    expect(canonicalJson({ d: new Date('2026-11-06T10:00:00Z') })).toBe(
      '{"d":"2026-11-06T10:00:00.000Z"}',
    )
    expect(() => canonicalJson({ n: Number.NaN })).toThrow()
  })

  it('orders keys by code point, as UTF-8 bytes sort', () => {
    // U+E000 comes before U+1F600 by code point, after it in UTF-16 units.
    expect(canonicalJson({ '\u{1F600}': 1, '': 2, b: 3, a: 4 })).toBe(
      '{"a":4,"b":3,"":2,"\u{1F600}":1}',
    )
    expect(canonicalJson({ ab: 1, a: 2 })).toBe('{"a":2,"ab":1}')
  })

  it('has no canonical form for two keys that are the same text in NFC', () => {
    expect(() => canonicalJson({ é: 1, ['é'.normalize('NFD')]: 2 })).toThrow()
  })

  it('refuses a recipe with a number written in exponent form', () => {
    const raw = sampleRecipe()
    const number = raw.parameters.find((p) => p.type === 'number') as Record<string, unknown>
    number.max = 1e21
    const v = validateRecipe(raw)
    expect(v.ok ? [] : v.errors.map((e) => e.code)).toEqual(['number_not_supported'])
  })
})
