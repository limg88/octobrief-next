import { describe, expect, it } from 'vitest'
import { ApiError, apiRequest } from '../src/lib/api-client.ts'

function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('apiRequest', () => {
  it('sends JSON with the CSRF token and parses the answer', async () => {
    const { impl, calls } = recordingFetch(Response.json({ ok: true }, { status: 201 }))
    const result = await apiRequest(
      '/projects',
      { method: 'POST', body: { name: 'A' }, csrfToken: 't' },
      impl,
    )
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.url).toBe('/api/projects')
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      body: '{"name":"A"}',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 't' },
    })
  })

  it('returns nothing for 204 and defaults to GET', async () => {
    const { impl, calls } = recordingFetch(new Response(null, { status: 204 }))
    expect(await apiRequest('/me', {}, impl)).toBeUndefined()
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('returns nothing for an accepted request without a body (202)', async () => {
    const { impl } = recordingFetch(new Response(null, { status: 202 }))
    expect(await apiRequest('/x', { method: 'POST', csrfToken: 't' }, impl)).toBeUndefined()
  })

  it('throws ApiError with code and field', async () => {
    const { impl } = recordingFetch(
      Response.json({ error: 'invalid', field: 'name' }, { status: 400 }),
    )
    await expect(apiRequest('/projects', {}, impl)).rejects.toMatchObject({
      status: 400,
      code: 'invalid',
      field: 'name',
    })
    const { impl: broken } = recordingFetch(new Response('oops', { status: 502 }))
    const error = await apiRequest('/x', {}, broken).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: 'unknown', field: undefined })
  })
})
