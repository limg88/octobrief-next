import { describe, expect, it } from 'vitest'
import { isAdmin, isLocale } from '../src/user.ts'

describe('isLocale', () => {
  it('accepts the supported locales only', () => {
    expect(isLocale('it')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
})

describe('isAdmin', () => {
  it('is true for admins only', () => {
    expect(isAdmin({ role: 'admin' })).toBe(true)
    expect(isAdmin({ role: 'pm' })).toBe(false)
  })
})
