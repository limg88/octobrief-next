import { describe, expect, it } from 'vitest'
import { FAKE_USERS, resolveUser } from '../src/users.ts'

describe('resolveUser', () => {
  it('finds fixtures by key and by email', () => {
    expect(resolveUser('paola')).toBe(FAKE_USERS.paola)
    expect(resolveUser(' MARCO.ESEMPIO@example.test ')).toBe(FAKE_USERS.marco)
  })

  it('builds a stable ad hoc person from name|email', () => {
    const first = resolveUser('Ugo Sintetico|Ugo@example.test')
    expect(first).toMatchObject({ name: 'Ugo Sintetico', email: 'ugo@example.test' })
    expect(resolveUser('Ugo Sintetico|ugo@example.test')).toEqual(first)
  })

  it('rejects anything else', () => {
    expect(resolveUser(null)).toBeNull()
    expect(resolveUser('nobody')).toBeNull()
    expect(resolveUser('|x@example.test')).toBeNull()
    expect(resolveUser('Name|not-an-email')).toBeNull()
  })
})
