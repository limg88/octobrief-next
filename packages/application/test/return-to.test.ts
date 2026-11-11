import { describe, expect, it } from 'vitest'
import { sanitizeReturnTo } from '../src/use-cases/return-to.ts'

describe('sanitizeReturnTo', () => {
  it.each([
    ['/projects/alpha?tab=1#top', '/projects/alpha?tab=1#top'],
    [null, '/'],
    ['', '/'],
    ['https://evil.test', '/'],
    ['//evil.test', '/'],
    ['/\\evil.test', '/'],
    ['/\tevil', '/'],
    ['/a/..//evil.test', '/'],
    [`/${'a'.repeat(3000)}`, '/'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected)
  })
})
