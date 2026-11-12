import { DomainError } from '@octobrief/domain'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const SHOWN = '[segreto]'
/** Longer than any token, key or password a connector uses. */
export const MAX_SECRET_LENGTH = 8192

/**
 * A credential in memory. It prints, serializes and interpolates as `[segreto]`; the value comes
 * out only through `reveal()`, at the point where a connector hands it to the remote system.
 */
export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    if (value.trim() === '' || value.length > MAX_SECRET_LENGTH) {
      throw new DomainError('secret_value_invalid')
    }
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  toString(): string {
    return SHOWN
  }

  toJSON(): string {
    return SHOWN
  }

  [Symbol.toPrimitive](): string {
    return SHOWN
  }

  [INSPECT](): string {
    return SHOWN
  }
}
