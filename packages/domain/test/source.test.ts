import { describe, expect, it } from 'vitest'
import {
  canManageSources,
  FILE_NAME_MAX_LENGTH,
  InvalidSourceError,
  isPullSource,
  itemFileName,
  normalizeSourceName,
} from '../src/index.ts'

describe('sources', () => {
  it('tells the sources the worker reads from those a feeder feeds', () => {
    expect(['jira', 'ado', 'm365', 'dwsi', 'files'].map((k) => isPullSource(k as 'jira'))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })

  it('cleans a name and refuses an empty or endless one', () => {
    expect(normalizeSourceName('  Jira   Borea ')).toBe('Jira Borea')
    for (const bad of ['   ', 'x'.repeat(121)]) {
      expect(() => normalizeSourceName(bad)).toThrow(InvalidSourceError)
    }
  })

  it('lets owners and admins manage sources, not members', () => {
    expect(canManageSources({ memberRole: 'owner', admin: false })).toBe(true)
    expect(canManageSources({ memberRole: null, admin: true })).toBe(true)
    expect(canManageSources({ memberRole: 'member', admin: false })).toBe(false)
  })

  it('names the file of an item after its title, safely, with the extension of its type', () => {
    expect(itemFileName('RE: Budget / Borea?', 'text/markdown; charset=utf-8', 'm-1')).toBe(
      'RE Budget Borea.md',
    )
    expect(itemFileName('note.TXT', 'text/plain', 'x')).toBe('note.TXT')
    expect(itemFileName('  ', 'application/x-unknown', 'sites/a:b')).toBe('sites a b')
    expect(itemFileName('', 'text/csv', '///')).toBe('item.csv')
    const long = itemFileName('a'.repeat(400), 'text/vtt', 'x')
    expect(long).toHaveLength(FILE_NAME_MAX_LENGTH)
    expect(long.endsWith('.vtt')).toBe(true)
  })
})
