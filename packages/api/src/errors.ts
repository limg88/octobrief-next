import { ApplicationError, type ApplicationErrorCode, FeedError } from '@octobrief/application'
import { InvalidDocumentError, InvalidProjectError, InvalidSourceError } from '@octobrief/domain'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

const STATUS: Record<ApplicationErrorCode, ContentfulStatusCode> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  login_failed: 401,
}

/** Maps expected failures to JSON responses; anything else is a 500 with no details. */
export function handleError(error: Error, c: Context): Response {
  // A source system refused the settings or the credential: its stable code says why.
  if (error instanceof ApplicationError && error.cause instanceof FeedError) {
    return c.json({ error: error.code, reason: error.cause.code }, STATUS[error.code])
  }
  if (error instanceof ApplicationError) {
    return c.json({ error: error.code }, STATUS[error.code])
  }
  if (error instanceof InvalidProjectError) {
    return c.json({ error: 'invalid', field: error.field }, 400)
  }
  if (error instanceof InvalidSourceError) {
    return c.json({ error: 'invalid', reason: error.reason }, 400)
  }
  if (error instanceof InvalidDocumentError) {
    return c.json({ error: 'invalid', reason: error.reason }, 400)
  }
  return c.json({ error: 'internal' }, 500)
}
