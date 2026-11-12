import { describe, expect, it } from 'vitest'
import { compareRecipeVersions, libraryNotice, recipeText } from '../src/recipe/index.ts'

describe('compareRecipeVersions', () => {
  it('orders versions by their numbers, not as text', () => {
    expect(compareRecipeVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareRecipeVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareRecipeVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareRecipeVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('refuses something that is not a version', () => {
    expect(() => compareRecipeVersions('1.2', '1.2.0')).toThrow()
  })
})

describe('libraryNotice', () => {
  it('says nothing when the pinned version is the newest published one', () => {
    expect(
      libraryNotice('1.1.0', [
        { version: '1.0.0', revoked: false },
        { version: '1.1.0', revoked: false },
      ]),
    ).toEqual({ newVersion: null, pinnedRevoked: false })
  })

  it('tells the PM a newer published version is available', () => {
    expect(
      libraryNotice('1.0.0', [
        { version: '1.0.0', revoked: false },
        { version: '1.2.0', revoked: false },
        { version: '1.1.0', revoked: false },
      ]),
    ).toEqual({ newVersion: '1.2.0', pinnedRevoked: false })
  })

  it('never offers a revoked version', () => {
    expect(
      libraryNotice('1.0.0', [
        { version: '1.0.0', revoked: false },
        { version: '1.1.0', revoked: true },
      ]),
    ).toEqual({ newVersion: null, pinnedRevoked: false })
  })

  it('keeps a revoked pinned version in use, with the notice', () => {
    expect(
      libraryNotice('1.1.0', [
        { version: '1.0.0', revoked: false },
        { version: '1.1.0', revoked: true },
      ]),
    ).toEqual({ newVersion: null, pinnedRevoked: true })
  })

  it('treats a pinned version without a publication as revoked', () => {
    expect(libraryNotice('1.0.0', [])).toEqual({ newVersion: null, pinnedRevoked: true })
  })

  it('has a text for the PM for each notice', () => {
    expect(recipeText('library', 'new_version_available', { version: '1.2.0' }, 'it')).toContain(
      'versione nuova',
    )
    expect(recipeText('library', 'pinned_revoked', {}, 'it')).not.toBe('')
  })
})
