import { CSRF_HEADER } from '@octobrief/api/cookies'

/** A failed API call: the HTTP status and the error code of the JSON body, when any. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | undefined
  readonly reason: string | undefined
  constructor(status: number, code: string, field?: string, reason?: string) {
    super(`API ${status}: ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
    this.reason = reason
  }
}

const NO_CONTENT = 204

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  csrfToken?: string
}

type Fetch = typeof fetch

async function errorOf(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown
    field?: unknown
    reason?: unknown
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  return new ApiError(
    res.status,
    text(body.error) ?? 'unknown',
    text(body.field),
    text(body.reason),
  )
}

/** Same-origin JSON call to `/api`; unsafe methods carry the session's CSRF token. */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  fetchImpl: Fetch = fetch,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  // A form (file upload) sets its own multipart content type with the boundary.
  const form = options.body instanceof FormData ? options.body : null
  if (options.body !== undefined && !form) headers['content-type'] = 'application/json'
  if (options.csrfToken) headers[CSRF_HEADER] = options.csrfToken
  const res = await fetchImpl(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: form ?? JSON.stringify(options.body) } : {}),
  })
  if (!res.ok) throw await errorOf(res)
  // An accepted request (202) has no body either: nothing to parse.
  const text = res.status === NO_CONTENT ? '' : await res.text()
  return (text === '' ? undefined : JSON.parse(text)) as T
}
