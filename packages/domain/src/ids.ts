import { DomainError } from './errors.ts'

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type ProjectId = Brand<string, 'ProjectId'>
export type SourceId = Brand<string, 'SourceId'>
export type EvidenceId = Brand<string, 'EvidenceId'>
export type UserId = Brand<string, 'UserId'>
export type QuestionId = Brand<string, 'QuestionId'>
export type FactId = Brand<string, 'FactId'>
export type InboxItemId = Brand<string, 'InboxItemId'>
export type SecretId = Brand<string, 'SecretId'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function newId<T extends string>(): T {
  return crypto.randomUUID() as T
}

export function parseId<T extends string>(raw: string): T {
  if (!UUID.test(raw)) {
    throw new DomainError('invalid_id')
  }
  return raw as T
}
