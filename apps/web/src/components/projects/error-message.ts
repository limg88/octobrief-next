import { ApiError } from '@/lib/api-client'

/** The message key of a failed call, within the namespace of the calling form. */
export function errorKey(error: unknown, known: readonly string[]): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === 'invalid' && error.field) {
    const key = `invalid${error.field.charAt(0).toUpperCase()}${error.field.slice(1)}`
    if (known.includes(key)) return key
  }
  return known.includes(error.code) ? error.code : null
}
