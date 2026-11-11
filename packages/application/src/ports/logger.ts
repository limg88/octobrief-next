/** Structured logging. Implementations must never receive secrets or personal data in `fields`. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}
