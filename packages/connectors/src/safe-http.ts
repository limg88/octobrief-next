import { lookup as dnsLookup } from 'node:dns/promises'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { addressAllowed, classifyAddress } from './addresses.ts'
import { ConnectorError, type SyncErrorCode } from './errors.ts'
import { checkRule, type HttpRule, pathAllowed, READ_METHODS, segmentsOf } from './rules.ts'

export type BlockReason =
  | 'url_invalid'
  | 'credentials_in_url'
  | 'scheme_not_allowed'
  | 'host_not_allowed'
  | 'method_not_allowed'
  | 'path_not_allowed'
  | 'address_not_allowed'
  | 'redirect_refused'

/** What is audited of a blocked call: never the query string, the headers or the body. */
export interface BlockedCall {
  reason: BlockReason
  method: string
  host: string
  path: string
}

/** One address a host name resolves to. */
export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface SafeHttpOptions {
  rules: readonly HttpRule[]
  /** Audits a blocked call; awaited before the refusal is thrown. */
  onBlocked: (call: BlockedCall) => Promise<void>
  /** Per attempt. */
  timeoutMs?: number
  maxResponseBytes?: number
  /** How many times a 429 or a 503 is tried again. */
  maxRetries?: number
  /** The longest single wait; a longer Retry-After fails the call with `source_rate_limited`. */
  maxRetryWaitMs?: number
  /**
   * Loopback addresses, and plain http to them: only the tests' fake servers. Off by default:
   * then loopback is refused like every private address.
   */
  allowLoopbackHttp?: boolean
  /**
   * Host names on a private network the Admin allows (`org_settings.private_hosts`): only these
   * may resolve to a private address, and never to a loopback, link-local or metadata one.
   */
  privateHosts?: readonly string[]
  /** Resolves a host name to every address it has; the system resolver by default. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  /** Aborts every call (the job stops). */
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * An extra certificate authority to trust: only the tests' self-signed servers. The worker's
   * configuration of the client (`connectorHttp`) does not include it.
   */
  testTrustedCa?: string
}

export interface SafeRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}

export interface SafeResponse {
  status: number
  headers: Headers
  body: Uint8Array
  text(): string
  /** Parses the body; `source_bad_response` when it is not JSON. */
  json(): unknown
}

export interface SafeHttp {
  request(req: SafeRequest): Promise<SafeResponse>
  /** A GET whose answer must be 2xx JSON; other statuses fail with their code. */
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>
  /** A POST that reads (a query) whose answer must be 2xx JSON. */
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>
  /** Closes the kept-alive connections of this client. */
  close(): void
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MAX_RETRY_WAIT_MS = 60_000
const FIRST_BACKOFF_MS = 1_000

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true })
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

/** The code of a non-2xx status that is not retried. */
export function statusCode(status: number): SyncErrorCode {
  if (status === 401) return 'source_auth_failed'
  if (status === 403) return 'source_forbidden'
  if (status === 404 || status === 410) return 'source_not_found'
  return 'source_http_error'
}

/** Milliseconds of a Retry-After header (seconds or an HTTP date); null when absent or unreadable. */
function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

function headersOf(res: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

/**
 * A lookup that answers only the vetted addresses: no second resolution between check and connect.
 * It answers asynchronously, like a real resolver: a connection that fails at once (a host
 * unreachable) then reports to the request's error handler instead of throwing past it.
 */
function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    const first = addresses[0] as ResolvedAddress
    setImmediate(() => {
      if (options?.all)
        callback(
          null,
          addresses.map((a) => ({ ...a })),
        )
      else callback(null, first.address, first.family)
    })
  }) as unknown as LookupFunction
}

interface Exchange {
  status: number
  headers: Headers
  res: IncomingMessage
}

/**
 * The only HTTP client of the connectors. Before the network: the URL must carry no credentials,
 * be https (http only to loopback when the tests allow it), and match a rule by method, exact
 * host and whole path (encoded separators refused); its host must resolve only to public
 * addresses (link-local, metadata, shared, multicast, unspecified and IPv4-mapped forms of them
 * are refused; loopback too, except for the tests; a private address only for a host on the
 * Admin's list of private hosts), and the connection is pinned to the vetted
 * addresses, so a DNS answer that changes in between is never used. Otherwise the call is audited
 * (reason, method, host, path) and refused with `call_blocked`. Rules allow reads only: GET, HEAD
 * and POST (some APIs query with POST). Redirects are never followed (`redirect_refused`,
 * audited). Each attempt has a timeout and the answer a size cap. 429 and 503 are tried again
 * after Retry-After (or an exponential backoff), a bounded number of times and never waiting
 * longer than allowed. Errors carry codes only.
 */
export function createSafeHttp(options: SafeHttpOptions): SafeHttp {
  const rules = options.rules.map(checkRule)
  // Agents of this client only: never the global agent, and so never a proxy from the
  // environment (NODE_USE_ENV_PROXY, HTTPS_PROXY), which would see every call.
  const agents = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({
      keepAlive: true,
      ...(options.testTrustedCa !== undefined ? { ca: options.testTrustedCa } : {}),
    }),
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxWait = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS
  const sleep = options.sleep ?? defaultSleep
  const resolve = options.resolve ?? systemResolve
  const loopbackAllowed = options.allowLoopbackHttp === true
  const privateHosts = new Set((options.privateHosts ?? []).map((h) => h.toLowerCase()))

  async function block(call: BlockedCall, code: SyncErrorCode = 'call_blocked'): Promise<never> {
    await options.onBlocked(call)
    throw new ConnectorError(code)
  }

  async function check(req: SafeRequest): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
    const method = req.method.toUpperCase()
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return block({ reason: 'url_invalid', method, host: '', path: '' })
    }
    const call = { method, host: url.host, path: url.pathname }
    if (url.username !== '' || url.password !== '') {
      return block({ ...call, reason: 'credentials_in_url' })
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const literal = isIP(hostname) !== 0
    const httpToLoopback =
      url.protocol === 'http:' &&
      loopbackAllowed &&
      (hostname === 'localhost' || (literal && classifyAddress(hostname) === 'loopback'))
    if (url.protocol !== 'https:' && !httpToLoopback) {
      return block({ ...call, reason: 'scheme_not_allowed' })
    }
    const forHost = rules.filter((r) => r.host === url.host.toLowerCase())
    if (forHost.length === 0) return block({ ...call, reason: 'host_not_allowed' })
    if (!(READ_METHODS as readonly string[]).includes(method)) {
      return block({ ...call, reason: 'method_not_allowed' })
    }
    const segments = segmentsOf(url.pathname)
    if (segments === null) return block({ ...call, reason: 'path_not_allowed' })
    const forPath = forHost.filter((r) => pathAllowed(r, segments))
    if (forPath.length === 0) return block({ ...call, reason: 'path_not_allowed' })
    if (!forPath.some((r) => r.method === method)) {
      return block({ ...call, reason: 'method_not_allowed' })
    }

    let addresses: ResolvedAddress[]
    if (literal) {
      addresses = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }]
    } else {
      try {
        addresses = await resolve(hostname)
      } catch {
        throw new ConnectorError('source_unreachable')
      }
      if (addresses.length === 0) throw new ConnectorError('source_unreachable')
    }
    // A private address only for a host name on the Admin's list, never for a literal address.
    const vet = {
      privateHost: !literal && privateHosts.has(hostname.toLowerCase()),
      allowLoopback: loopbackAllowed,
    }
    const allowed = addresses.every((a) => addressAllowed(classifyAddress(a.address), vet))
    if (!allowed) return block({ ...call, reason: 'address_not_allowed' })
    return { url, addresses }
  }

  function failureOf(timeout: AbortSignal): unknown {
    if (options.signal?.aborted) return options.signal.reason
    if (timeout.aborted) return new ConnectorError('source_timeout')
    return new ConnectorError('source_unreachable')
  }

  function send(
    req: SafeRequest,
    url: URL,
    addresses: readonly ResolvedAddress[],
    signal: AbortSignal,
    timeout: AbortSignal,
  ): Promise<Exchange> {
    const client = url.protocol === 'https:' ? https : http
    const body = req.body
    return new Promise((done, fail) => {
      const outgoing = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          ...(url.port ? { port: Number(url.port) } : {}),
          path: `${url.pathname}${url.search}`,
          method: req.method.toUpperCase(),
          headers: {
            ...req.headers,
            ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          },
          lookup: pinnedLookup(addresses),
          agent: url.protocol === 'https:' ? agents.https : agents.http,
          signal,
        },
        (res) => done({ status: res.statusCode ?? 0, headers: headersOf(res), res }),
      )
      outgoing.on('error', () => fail(failureOf(timeout)))
      if (body !== undefined) outgoing.write(body)
      outgoing.end()
    })
  }

  async function readCapped(
    res: IncomingMessage,
    timeout: AbortSignal,
    head: boolean,
  ): Promise<Uint8Array> {
    // A HEAD answer has no body: its content-length describes the GET, not what is read.
    const declared = head ? Number.NaN : Number(res.headers['content-length'])
    if (Number.isFinite(declared) && declared > cap) {
      res.destroy()
      throw new ConnectorError('response_too_large')
    }
    const parts: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of res) {
        const part = chunk as Buffer
        size += part.byteLength
        if (size > cap) {
          res.destroy()
          throw new ConnectorError('response_too_large')
        }
        parts.push(part)
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error
      throw failureOf(timeout)
    }
    return new Uint8Array(Buffer.concat(parts, size))
  }

  async function request(req: SafeRequest): Promise<SafeResponse> {
    const { url, addresses } = await check(req)
    for (let retry = 0; ; retry += 1) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const { status, headers, res } = await send(req, url, addresses, signal, timeout)
      if (status >= 300 && status < 400) {
        res.destroy()
        return block(
          {
            reason: 'redirect_refused',
            method: req.method.toUpperCase(),
            host: url.host,
            path: url.pathname,
          },
          'redirect_refused',
        )
      }
      if (status === 429 || status === 503) {
        res.resume()
        const code = status === 429 ? 'source_rate_limited' : 'source_unavailable'
        const asked = retryAfterMs(headers.get('retry-after'), Date.now())
        const wait = asked ?? FIRST_BACKOFF_MS * 2 ** retry
        if (retry >= maxRetries || wait > maxWait) {
          throw new ConnectorError(code, { retryAfterMs: wait })
        }
        await sleep(wait, options.signal)
        continue
      }
      const body = await readCapped(res, timeout, req.method.toUpperCase() === 'HEAD')
      const text = () => new TextDecoder().decode(body)
      return {
        status,
        headers,
        body,
        text,
        json() {
          try {
            return JSON.parse(text())
          } catch {
            throw new ConnectorError('source_bad_response')
          }
        },
      }
    }
  }

  async function expectJson(req: SafeRequest): Promise<unknown> {
    const res = await request(req)
    if (res.status < 200 || res.status >= 300) throw new ConnectorError(statusCode(res.status))
    return res.json()
  }

  return {
    request,
    close() {
      agents.http.destroy()
      agents.https.destroy()
    },
    getJson: (url, headers) =>
      expectJson({
        method: 'GET',
        url,
        headers: { accept: 'application/json', ...headers },
      }),
    postJson: (url, body, headers) =>
      expectJson({
        method: 'POST',
        url,
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
  }
}
