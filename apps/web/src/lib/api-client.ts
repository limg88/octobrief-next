import { CSRF_HEADER } from '@octobrief/api/cookies'

/** A failed API call: the HTTP status and the error code of the JSON body, when any. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | undefined
  constructor(status: number, code: string, field?: string) {
    super(`API ${status}: ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
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
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; field?: unknown }
  return new ApiError(
    res.status,
    typeof body.error === 'string' ? body.error : 'unknown',
    typeof body.field === 'string' ? body.field : undefined,
  )
}

/** Same-origin JSON call to `/api`; unsafe methods carry the session's CSRF token. */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
  fetchImpl: Fetch = fetch,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.csrfToken) headers[CSRF_HEADER] = options.csrfToken
  const res = await fetchImpl(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  if (!res.ok) throw await errorOf(res)
  return (res.status === NO_CONTENT ? undefined : await res.json()) as T
}
