import { createHash, createHmac } from 'node:crypto'
import { DomainError } from './errors.ts'
import type { Brand } from './ids.ts'

/** Form: 'person-' followed by 12 hex characters. */
export type AuthorPseudonym = Brand<string, 'AuthorPseudonym'>

/** Form: 'sha256:' followed by 64 hex characters. */
export type ContentHash = Brand<string, 'ContentHash'>

/**
 * HMAC-SHA256(key = projectKey, message = UTF-8 of identity.trim().toLowerCase()),
 * first 12 hex characters. The database function `project_author_pseudonym` reproduces this
 * exactly (same trimmed whitespace set, ICU lowercasing, pgcrypto hmac with sha256).
 */
export function pseudonymizeAuthor(identity: string, projectKey: Uint8Array): AuthorPseudonym {
  if (projectKey.byteLength === 0) {
    throw new DomainError('pseudonym_key_empty')
  }
  const digest = createHmac('sha256', projectKey)
    .update(identity.trim().toLowerCase(), 'utf8')
    .digest('hex')
  return `person-${digest.slice(0, 12)}` as AuthorPseudonym
}

/** The content hash of a SHA-256 hex digest computed elsewhere (e.g. while streaming a file). */
export function contentHashFromHex(hex: string): ContentHash {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('invalid sha256 digest')
  return `sha256:${hex}` as ContentHash
}

export function hashContent(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ContentHash
}
