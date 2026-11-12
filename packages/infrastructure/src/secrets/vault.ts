import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SealedSecret, SecretVault } from '@octobrief/application'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
export const KEY_BYTES = 32
const MAX_VERSION = 0xffffffff
/** `<version>:<base64 of 32 bytes>`; without a prefix the version is 1. */
const FORMAT = /^(?:([1-9]\d{0,9}):)?([A-Za-z0-9+/]{43}=)$/

/** A stored secret that this key cannot open: another key, another source, or a changed byte. */
export class SecretUndecryptableError extends Error {
  constructor() {
    super('secret undecryptable')
    this.name = 'SecretUndecryptableError'
  }
}

export interface SecretsKey {
  readonly version: number
  readonly material: Uint8Array
}

/** Reads the installation's key (`SECRETS_KEY`); null when the value is not one. */
export function readSecretsKey(value: string): SecretsKey | null {
  const match = FORMAT.exec(value)
  if (!match) return null
  const version = match[1] === undefined ? 1 : Number(match[1])
  const material = Buffer.from(match[2] as string, 'base64')
  if (material.length !== KEY_BYTES || version > MAX_VERSION) return null
  return { version, material }
}

/** The authenticated data: the id of the source (16 bytes) and the key version (uint32, BE). */
function additionalData(sourceId: string, keyVersion: number): Buffer {
  const aad = Buffer.alloc(20)
  Buffer.from(sourceId.replaceAll('-', ''), 'hex').copy(aad, 0)
  aad.writeUInt32BE(keyVersion, 16)
  return aad
}

/**
 * AES-256-GCM with a fresh random IV per secret, bound to the source it belongs to: a sealed
 * credential copied onto another source does not open.
 */
export function createSecretVault(key: SecretsKey): SecretVault {
  return {
    seal(sourceId, value) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key.material, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(additionalData(sourceId, key.version))
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return { keyVersion: key.version, iv, tag: cipher.getAuthTag(), ciphertext }
    },
    unseal(sourceId, sealed: SealedSecret) {
      if (
        sealed.keyVersion !== key.version ||
        sealed.iv.length !== IV_BYTES ||
        sealed.tag.length !== TAG_BYTES
      ) {
        throw new SecretUndecryptableError()
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key.material, sealed.iv, {
          authTagLength: TAG_BYTES,
        })
        decipher.setAAD(additionalData(sourceId, sealed.keyVersion))
        decipher.setAuthTag(sealed.tag)
        return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString(
          'utf8',
        )
      } catch {
        throw new SecretUndecryptableError()
      }
    },
  }
}
