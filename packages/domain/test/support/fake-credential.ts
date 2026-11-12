import { randomBytes } from 'node:crypto'

/**
 * A password-shaped value made at run time, so that no credential-like literal sits in the
 * sources: a letter, a digit and a symbol, then random hexadecimal digits.
 */
export function fakePassword(): string {
  return ['Qx7!', randomBytes(5).toString('hex')].join('')
}
