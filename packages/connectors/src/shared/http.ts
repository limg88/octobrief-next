import { ConnectorError } from '../errors.ts'
import { type SafeHttp, type SafeResponse, statusCode } from '../safe-http.ts'
import type { SecretValue } from '../secret-value.ts'

/**
 * The Basic Authorization header of a user and a secret. The value goes into a header only:
 * never a URL, a log or a failure (failures carry codes only).
 */
export function basicAuthorization(user: string, secret: SecretValue | null): string {
  if (secret === null) throw new ConnectorError('source_credentials_missing')
  return `Basic ${Buffer.from(`${user}:${secret.reveal()}`).toString('base64')}`
}

/**
 * One call through the safe client, asking for JSON. No `accept-encoding`: the client does not
 * decompress. A status outside 2xx fails with its code; a 2xx answer is returned as it is.
 */
export async function sendJson(
  http: SafeHttp,
  method: 'GET' | 'POST',
  url: string,
  authorization: string,
  body?: unknown,
): Promise<SafeResponse> {
  const headers: Record<string, string> = { accept: 'application/json', authorization }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await http.request({
    method,
    url,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status < 200 || res.status >= 300) throw new ConnectorError(statusCode(res.status))
  return res
}
