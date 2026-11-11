import { describe, expect, it } from 'vitest'
import { describeLoginFailure, InvalidClaimsError, identityFromClaims } from '../src/oidc/claims.ts'

const ISSUER = 'https://login.microsoftonline.com/tenant/v2.0'
const base = {
  iss: ISSUER,
  oid: 'oid-1',
  sub: 'sub-1',
  name: 'Paola Prova',
  preferred_username: 'Paola.Prova@example.test',
}

describe('identityFromClaims', () => {
  it('uses the issuer-qualified oid and trusts the UPN of the own tenant', () => {
    expect(identityFromClaims(base, `${ISSUER}/`)).toEqual({
      externalSubject: `${ISSUER}|oid-1`,
      displayName: 'Paola Prova',
      email: 'paola.prova@example.test',
      emailVerified: true,
    })
  })

  it('does not trust emails from another issuer, guests or unverified addresses', () => {
    expect(identityFromClaims({ ...base, iss: 'https://other.test' }, ISSUER).emailVerified).toBe(
      false,
    )
    const guest = { ...base, preferred_username: 'p_ext#EXT#@tenant.test' }
    expect(identityFromClaims(guest, ISSUER).emailVerified).toBe(false)
    const other = { ...base, email: 'someone@else.test' }
    expect(identityFromClaims(other, ISSUER).emailVerified).toBe(false)
    expect(identityFromClaims({ ...other, xms_edov: true }, ISSUER).emailVerified).toBe(true)
  })

  it('falls back to sub and to the username for the name', () => {
    const identity = identityFromClaims(
      { iss: ISSUER, sub: 'sub-2', preferred_username: 'nomail' },
      ISSUER,
    )
    expect(identity).toEqual({
      externalSubject: `${ISSUER}|sub-2`,
      displayName: 'nomail',
      email: null,
      emailVerified: false,
    })
  })

  it('rejects tokens without subject or name', () => {
    expect(() => identityFromClaims({ iss: ISSUER }, ISSUER)).toThrow(InvalidClaimsError)
    expect(() => identityFromClaims({ iss: ISSUER, sub: 'x' }, ISSUER)).toThrow(/usable name/)
  })
})

describe('describeLoginFailure', () => {
  it('chains causes with codes and strips control characters', () => {
    const cause = Object.assign(new Error('bad\nline'), { code: 'E_X' })
    const line = describeLoginFailure(new Error('outer', { cause }))
    expect(line).toBe('Error: outer <- Error[E_X]: bad line')
    expect(describeLoginFailure('nope')).toBe('unknown error')
  })
})
