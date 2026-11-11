export const APPLICATION_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'invalid',
  'login_failed',
] as const
export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number]

/** A failure a use case reports on purpose; interfaces map the code to their own status. */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode
  constructor(code: ApplicationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ApplicationError'
    this.code = code
  }
}
