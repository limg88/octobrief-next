import { Socket } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import pg from 'pg'
import { ConnectorError, type SyncErrorCode } from '../errors.ts'
import type { VettedHost } from '../net-guard.ts'

/** A read-only session on the warehouse: fixed, parametrized queries only. */
export interface DwsiSession {
  /** One query; `maxRows` lowers the session's row limit for it. */
  query(
    text: string,
    params?: readonly unknown[],
    options?: { maxRows?: number },
  ): Promise<Record<string, unknown>[]>
  close(): Promise<void>
}

export interface SessionTarget {
  host: string
  port: number
  database: string
  user: string
  password: string
  vetted: VettedHost
  signal: AbortSignal
  /** Rows any query gives at most: one more aborts the session (`response_too_large`). */
  maxRows: number
}

/**
 * Limits of one session: the connection and every statement are bounded in time, and what the
 * warehouse sends is bounded in size whatever it does (a server that ignores LIMIT, a huge row):
 * the bytes are counted at the socket and the session is cut beyond them.
 */
export interface SessionLimits {
  connectTimeoutMs: number
  statementTimeoutMs: number
  /** Bytes received in one session at most. */
  maxSessionBytes: number
  /** Bytes of one row at most. */
  maxRowBytes: number
  /**
   * How long the client waits for the server beyond its own limits: past the statement timeout
   * before it cuts the session itself, and after saying goodbye before it drops the connection.
   */
  graceMs: number
}

export const SESSION_LIMITS: SessionLimits = {
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  maxSessionBytes: 64 * 1024 * 1024,
  maxRowBytes: 1024 * 1024,
  graceMs: 5_000,
}

// Values as the warehouse writes them: exact texts for numerics, dates, instants and 64-bit
// integers (no float rounding, no time zone of the worker); small integers, floats and booleans
// as JSON numbers and booleans.
const BOOL = 16
const INT2 = 21
const INT4 = 23
const FLOAT4 = 700
const FLOAT8 = 701
const TYPES = {
  getTypeParser(oid: number) {
    if (oid === BOOL) return (v: string) => v === 't'
    if (oid === INT2 || oid === INT4) return (v: string) => Number(v)
    if (oid === FLOAT4 || oid === FLOAT8) return (v: string) => Number(v)
    return (v: string) => v
  },
}

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
])

/**
 * Which check failed, for a failure of the warehouse: its SQLSTATE (`sqlstate_22012`) or the
 * code of the network error (`econnreset`); never its message.
 */
export function reasonOfPgError(error: unknown): string | undefined {
  if (error instanceof ConnectorError) return error.reason ?? undefined
  const code = (error as { code?: unknown })?.code
  if (typeof code !== 'string') return undefined
  if (/^[0-9A-Z]{5}$/.test(code)) return `sqlstate_${code.toLowerCase()}`
  if (/^E[A-Z_]{2,30}$/.test(code)) return code.toLowerCase()
  return undefined
}

/** A failure of the warehouse as the connector throws it: its code, and which check failed. */
export function pgFailure(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error
  const reason = reasonOfPgError(error)
  return new ConnectorError(codeOfPgError(error), reason ? { reason } : {})
}

/** The code of a failure of the warehouse or of the way to it; never its message. */
export function codeOfPgError(error: unknown): SyncErrorCode {
  if (error instanceof ConnectorError) return error.code
  const e = error as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : ''
  const message = typeof e?.message === 'string' ? e.message : ''
  if (TLS_ERRORS.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
    return 'tls_not_verified'
  }
  if (/does not support SSL|error establishing an SSL connection/.test(message)) {
    return 'tls_not_verified'
  }
  // SQLSTATE classes and codes of the server.
  if (code === '28P01' || code === '28000') return 'source_auth_failed'
  if (code === '3D000') return 'source_not_found'
  if (code === '42501') return 'source_forbidden'
  if (code === '42P01' || code === '42703' || code === '3F000') return 'definition_changed'
  if (code === '57014') return 'source_timeout'
  if (code === '53300' || code === '57P03') return 'source_unavailable'
  if (/^08/.test(code)) return 'source_unreachable'
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'source_unreachable'
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'source_unreachable'
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) return 'source_timeout'
  if (/terminated|Connection ended|ended unexpectedly/i.test(message)) return 'source_unreachable'
  return 'source_bad_response'
}

/**
 * How the connection is secured, from the Admin's entry for a private host (a public host is
 * always verified against the system's authorities): TLS checking the certificate against the
 * host name (`verify_full`, with the Admin's authority when given), TLS without the check, or
 * no TLS, the last two only when the Admin chose them for that host.
 */
export function tlsOf(host: string, vetted: VettedHost): ConnectionOptions | false {
  const mode = vetted.privateHost.databaseTls
  if (mode === 'plaintext') return false
  if (mode === 'unverified') return { servername: host, rejectUnauthorized: false }
  const ca = vetted.privateHost.caPem
  return { servername: host, rejectUnauthorized: true, ...(ca ? { ca } : {}) }
}

/** The bytes of a row as parsed: the texts and the other values. */
function rowBytes(row: Record<string, unknown>): number {
  let bytes = 0
  for (const v of Object.values(row)) bytes += typeof v === 'string' ? Buffer.byteLength(v) : 8
  return bytes
}

interface PgConnection {
  stream: Socket
  on(event: string, listener: (...args: unknown[]) => void): void
}

/**
 * Opens a session on the warehouse: to the vetted address (never a second resolution), TLS
 * named for the host, every transaction read-only by default, statements and the connection
 * bounded in time, and the bytes and rows it receives bounded. The password goes only as the
 * answer of a SCRAM exchange: a server asking for it in clear or as MD5 is refused before it is
 * sent (`auth_not_secure`). Nothing is read from the environment (no PGPASSWORD, no .pgpass).
 * A failure has its code only.
 */
export async function openDwsiSession(
  target: SessionTarget,
  limits: SessionLimits = SESSION_LIMITS,
): Promise<DwsiSession> {
  const address = target.vetted.addresses[0]
  if (!address) throw new ConnectorError('source_unreachable')
  if (target.password === '') throw new ConnectorError('source_credentials_missing')
  let failure: SyncErrorCode | null = null
  let received = 0
  const socket = new Socket()
  const refuse = (code: SyncErrorCode) => {
    failure ??= code
    socket.destroy()
    connection.stream.destroy()
  }
  const count = (chunk: unknown) => {
    received += (chunk as Buffer).byteLength
    if (received > limits.maxSessionBytes) refuse('response_too_large')
  }
  socket.on('data', count)
  const client = new pg.Client({
    host: address.address,
    port: target.port,
    database: target.database,
    user: target.user,
    // A function: pg then never falls back to PGPASSWORD or a password file.
    password: () => {
      if (failure) throw new ConnectorError(failure)
      return target.password
    },
    ssl: tlsOf(target.host, target.vetted),
    stream: () => socket,
    connectionTimeoutMillis: limits.connectTimeoutMs,
    statement_timeout: limits.statementTimeoutMs,
    idle_in_transaction_session_timeout: limits.statementTimeoutMs,
    application_name: 'octobrief-dwsi',
    client_encoding: 'UTF8',
    options: '-c default_transaction_read_only=on',
    types: TYPES,
  })
  const connection = (client as unknown as { connection: PgConnection }).connection
  // Registered before pg's own handlers: the password is never sent but through SCRAM.
  connection.on('authenticationCleartextPassword', () => refuse('auth_not_secure'))
  connection.on('authenticationMD5Password', () => refuse('auth_not_secure'))
  // Under TLS the bytes are counted on the secure stream that replaces the socket.
  connection.on('sslconnect', () => connection.stream.on('data', count))
  // A failure after connecting (the server going away) is read by the next query.
  client.on('error', () => undefined)
  /**
   * Says goodbye and waits for the server to let go, for the grace at most: a server that keeps
   * the connection open is dropped.
   */
  const end = async () => {
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limits.graceMs)
    })
    await Promise.race([client.end().catch(() => undefined), grace])
    clearTimeout(timer)
    socket.destroy()
    connection.stream.destroy()
  }
  const abort = () => {
    void end()
  }
  const failed = (error: unknown) => (failure ? new ConnectorError(failure) : pgFailure(error))
  if (target.signal.aborted) throw target.signal.reason
  target.signal.addEventListener('abort', abort, { once: true })
  try {
    await client.connect()
    if (failure) throw new ConnectorError(failure)
  } catch (error) {
    target.signal.removeEventListener('abort', abort)
    await end()
    if (target.signal.aborted) throw target.signal.reason
    throw failed(error)
  }
  return {
    query(text, params = [], options = {}) {
      if (failure) return Promise.reject(new ConnectorError(failure))
      const maxRows = Math.min(options.maxRows ?? target.maxRows, target.maxRows)
      return new Promise((resolve, reject) => {
        // Row by row, without a callback (pg then keeps no rows of its own): what the server
        // sends beyond the limits is never kept, and the session is cut.
        const rows: Record<string, unknown>[] = []
        const query = new pg.Query(text, [...params])
        // The server's statement timeout is not trusted alone: the client cuts the session too.
        const timer = setTimeout(
          () => refuse('source_timeout'),
          limits.statementTimeoutMs + limits.graceMs,
        )
        const settle = (error: unknown) => {
          clearTimeout(timer)
          if (target.signal.aborted) reject(target.signal.reason)
          else if (error !== null || failure) reject(failed(error))
          else resolve(rows)
        }
        query.on('row', (row: Record<string, unknown>) => {
          if (failure) return
          if (rows.length >= maxRows || rowBytes(row) > limits.maxRowBytes) {
            refuse('response_too_large')
            return
          }
          rows.push(row)
        })
        query.on('end', () => settle(null))
        query.on('error', (error: unknown) => settle(error))
        client.query(query)
      })
    },
    async close() {
      target.signal.removeEventListener('abort', abort)
      await end()
    },
  }
}
