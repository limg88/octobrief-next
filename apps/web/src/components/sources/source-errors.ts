import { ApiError } from '@/lib/api-client'

/** Reasons a source is refused that have a message of their own. */
export const SOURCE_ERRORS = [
  'invalid_name',
  'invalid_feed',
  'secret_required',
  'folder_required',
  'folder_feed_disabled',
  'folder_not_found',
  'folder_not_allowed',
  'source_auth_failed',
  'source_forbidden',
  'source_not_configured',
  'source_unreachable',
  'write_scope_refused',
  'conflict',
  'forbidden',
] as const

export function sourceErrorKey(error: unknown): (typeof SOURCE_ERRORS)[number] | null {
  if (!(error instanceof ApiError)) return null
  const candidate = error.code === 'invalid' ? error.reason : error.code
  return SOURCE_ERRORS.find((key) => key === candidate) ?? null
}
