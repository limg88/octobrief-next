/** A broken rule of the domain: `code` is stable and maps to a user-facing message. */
export class DomainError extends Error {
  readonly code: string
  readonly params?: Record<string, string | number>

  constructor(code: string, params?: Record<string, string | number>) {
    super(code)
    this.name = 'DomainError'
    this.code = code
    if (params !== undefined) this.params = params
  }
}
