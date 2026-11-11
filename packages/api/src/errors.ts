import { ApplicationError, type ApplicationErrorCode } from '@octobrief/application'
import { InvalidProjectError } from '@octobrief/domain'
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
  if (error instanceof ApplicationError) {
    return c.json({ error: error.code }, STATUS[error.code])
  }
  if (error instanceof InvalidProjectError) {
    return c.json({ error: 'invalid', field: error.field }, 400)
  }
  return c.json({ error: 'internal' }, 500)
}
