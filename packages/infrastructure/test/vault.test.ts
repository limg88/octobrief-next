import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createSecretVault,
  readSecretsKey,
  SecretUndecryptableError,
} from '../src/secrets/vault.ts'

const material = () => randomBytes(32).toString('base64')

describe('secrets key', () => {
  it('reads 32 bytes in base64, with an optional version', () => {
    const value = material()
    expect(readSecretsKey(value)).toMatchObject({ version: 1 })
    expect(readSecretsKey(`7:${value}`)).toMatchObject({ version: 7 })
    for (const bad of ['', 'short', `0:${value}`, `99999999999:${value}`, value.slice(0, 40)]) {
      expect(readSecretsKey(bad)).toBeNull()
    }
  })
})

describe('secret vault', () => {
  const key = readSecretsKey(material()) as NonNullable<ReturnType<typeof readSecretsKey>>
  const vault = createSecretVault(key)
  const sourceId = randomUUID()

  it('opens what it sealed, and never stores the value in clear', () => {
    const sealed = vault.seal(sourceId, 'pat-molto-segreto')
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain('segreto')
    expect(vault.seal(sourceId, 'pat-molto-segreto').iv).not.toEqual(sealed.iv)
    expect(vault.unseal(sourceId, sealed)).toBe('pat-molto-segreto')
  })

  it('refuses a secret moved to another source, changed, or sealed with another key', () => {
    const sealed = vault.seal(sourceId, 'pat')
    const changed = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext).fill(0) }
    const other = createSecretVault(readSecretsKey(material()) as typeof key)
    const attempts = [
      () => vault.unseal(randomUUID(), sealed),
      () => vault.unseal(sourceId, changed),
      () => vault.unseal(sourceId, { ...sealed, keyVersion: 2 }),
      () => vault.unseal(sourceId, { ...sealed, iv: new Uint8Array(4) }),
      () => other.unseal(sourceId, sealed),
    ]
    for (const attempt of attempts) expect(attempt).toThrow(SecretUndecryptableError)
  })
})
