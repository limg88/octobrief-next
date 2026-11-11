import { describe, expect, it } from 'vitest'
import {
  canManageMembers,
  InvalidProjectError,
  normalizeProjectInput,
  PROJECT_NAME_MAX_LENGTH,
  slugify,
  uniqueSlug,
} from '../src/project.ts'

describe('slugify', () => {
  it('lowercases, strips accents and joins words with dashes', () => {
    expect(slugify('  Città Metropolitana — Fase 2 ')).toBe('citta-metropolitana-fase-2')
  })

  it('falls back when nothing usable is left', () => {
    expect(slugify('!!!')).toBe('project')
  })

  it('caps the length without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(59)} b`)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('uniqueSlug', () => {
  it('appends the first free counter', () => {
    expect(uniqueSlug('alpha', new Set())).toBe('alpha')
    expect(uniqueSlug('alpha', new Set(['alpha', 'alpha-2']))).toBe('alpha-3')
  })
})

describe('normalizeProjectInput', () => {
  it('trims and collapses spaces', () => {
    expect(normalizeProjectInput({ name: '  Alpha   Beta ', client: '  ' })).toEqual({
      name: 'Alpha Beta',
      client: null,
    })
  })

  it('rejects an empty name', () => {
    expect(() => normalizeProjectInput({ name: ' ' })).toThrow(InvalidProjectError)
  })

  it('rejects names and clients that are too long', () => {
    const long = 'x'.repeat(PROJECT_NAME_MAX_LENGTH + 1)
    expect(() => normalizeProjectInput({ name: long })).toThrow(/name/)
    expect(() => normalizeProjectInput({ name: 'ok', client: long })).toThrow(/client/)
  })
})

describe('canManageMembers', () => {
  it('allows owners and admins', () => {
    expect(canManageMembers('owner', false)).toBe(true)
    expect(canManageMembers(null, true)).toBe(true)
    expect(canManageMembers('member', false)).toBe(false)
    expect(canManageMembers(null, false)).toBe(false)
  })
})
