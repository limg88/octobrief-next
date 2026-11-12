import { afterEach, describe, expect, it } from 'vitest'
import { openDwsiSession, SESSION_LIMITS, type SessionLimits } from '../src/dwsi/session.ts'
import { ConnectorError } from '../src/index.ts'
import {
  type HostileMode,
  type HostilePostgres,
  startHostilePostgres,
} from './support/hostile-postgres.ts'
import { selfSigned, startTlsPostgres, type TlsPostgres } from './support/tls-postgres.ts'

const HOST = 'dwsi.corp.example'
const PASSWORD = 'pw-of-the-account-1234'
const servers: (HostilePostgres | TlsPostgres)[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function hostile(mode: HostileMode, limits: Partial<SessionLimits> = {}) {
  const server = await startHostilePostgres(mode)
  servers.push(server)
  const open = () =>
    openDwsiSession(
      {
        host: HOST,
        port: server.port,
        database: 'dwsi',
        user: 'reader',
        password: PASSWORD,
        vetted: {
          addresses: [{ address: '127.0.0.1', family: 4 }],
          privateHost: { host: HOST, databaseTls: 'plaintext', caPem: null },
        },
        signal: new AbortController().signal,
        maxRows: 20_000,
      },
      { ...SESSION_LIMITS, ...limits },
    )
  return { server, open }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError)
    return (error as ConnectorError).code
  }
  throw new Error('expected a connector failure')
}

describe('a session on a hostile warehouse', () => {
  it('cuts a server that ignores LIMIT once it sends one row too many', async () => {
    const { server, open } = await hostile({ kind: 'rows', count: 25_000 })
    const session = await open()
    try {
      expect(await codeOf(session.query('SELECT v FROM x LIMIT 20001', ['p']))).toBe(
        'response_too_large',
      )
      // The session is unusable afterwards: nothing more is read from it.
      expect(await codeOf(session.query('SELECT 1'))).toBe('response_too_large')
    } finally {
      await session.close()
    }
    await expect.poll(() => server.cut).toBe(true)
  })

  it('applies the lower row limit of a query', async () => {
    const { open } = await hostile({ kind: 'rows', count: 3 })
    const session = await open()
    try {
      expect(await codeOf(session.query('SELECT v', [], { maxRows: 2 }))).toBe('response_too_large')
    } finally {
      await session.close()
    }
  })

  it('gives 64-bit integers, numerics, dates and instants as the exact text the server wrote', async () => {
    const { open } = await hostile({
      kind: 'typed',
      columns: [
        { name: 'internalid', oid: 20, text: '9007199254740993' },
        { name: 'duration', oid: 1700, text: '7.5000' },
        { name: 'timesheetdate', oid: 1082, text: '2026-11-02' },
        { name: 'datelastsync', oid: 1114, text: '2026-11-09 06:00:00.123456' },
        { name: 'amount', oid: 701, text: '0.30000000000000004' },
        { name: 'lineid', oid: 23, text: null },
        { name: 'flag', oid: 16, text: 't' },
      ],
    })
    const session = await open()
    try {
      expect(await session.query('SELECT 1', ['p'])).toEqual([
        {
          internalid: '9007199254740993',
          duration: '7.5000',
          timesheetdate: '2026-11-02',
          datelastsync: '2026-11-09 06:00:00.123456',
          amount: 0.30000000000000004,
          lineid: null,
          flag: true,
        },
      ])
    } finally {
      await session.close()
    }
  })

  it('names the SQLSTATE of a failure of the server as its reason, never its message', async () => {
    const { open } = await hostile({
      kind: 'error',
      sqlstate: '22012',
      message: 'division by zero for Apollo 1234.56',
    })
    const session = await open()
    try {
      const failure = await session.query('SELECT 1', ['p']).then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ConnectorError)
      expect((failure as ConnectorError).code).toBe('source_bad_response')
      expect((failure as ConnectorError).reason).toBe('sqlstate_22012')
      expect(JSON.stringify(failure)).not.toMatch(/Apollo|1234/)
      expect(String(failure)).not.toMatch(/Apollo|1234/)
    } finally {
      await session.close()
    }
  })

  it('gives the rows of a well-behaved answer', async () => {
    const { open } = await hostile({ kind: 'rows', count: 3 })
    const session = await open()
    try {
      expect(await session.query('SELECT v', ['p'])).toEqual([{ v: 'x' }, { v: 'x' }, { v: 'x' }])
    } finally {
      await session.close()
    }
  })

  it('cuts a row larger than a row may be', async () => {
    const { open } = await hostile({ kind: 'huge_row', bytes: 2 * 1024 * 1024 })
    const session = await open()
    try {
      expect(await codeOf(session.query('SELECT v', ['p']))).toBe('response_too_large')
    } finally {
      await session.close()
    }
  })

  it('cuts an endless answer at the bytes of a session, without holding it in memory', async () => {
    const { server, open } = await hostile({ kind: 'flood' }, { maxSessionBytes: 4 * 1024 * 1024 })
    const before = process.memoryUsage().heapUsed
    const session = await open()
    try {
      expect(await codeOf(session.query('SELECT v', ['p']))).toBe('response_too_large')
    } finally {
      await session.close()
    }
    await expect.poll(() => server.cut).toBe(true)
    // What was received is bounded by the cut, not by what the server would send.
    expect(server.sent).toBeLessThan(64 * 1024 * 1024)
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024)
  })

  it.each(['cleartext', 'md5'] as const)(
    'never sends the password to a server that asks for it as %s',
    async (kind) => {
      const { server, open } = await hostile({ kind })
      expect(await codeOf(open())).toBe('auth_not_secure')
      const sent = Buffer.concat(server.received).toString('latin1')
      expect(sent).not.toContain(PASSWORD)
      // No password message at all after the startup.
      expect(server.received.slice(1).some((b) => b[0] === 'p'.charCodeAt(0))).toBe(false)
    },
  )

  it('cuts a statement the server never answers, on its own timer', async () => {
    const { open } = await hostile({ kind: 'silent' }, { statementTimeoutMs: 100, graceMs: 100 })
    const session = await open()
    const started = Date.now()
    try {
      expect(await codeOf(session.query('SELECT v', ['p']))).toBe('source_timeout')
    } finally {
      await session.close()
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('closes an idle session even when the server never lets go', async () => {
    const { open } = await hostile({ kind: 'silent' }, { graceMs: 100 })
    const session = await open()
    const started = Date.now()
    await session.close()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('counts the bytes received under TLS too', async () => {
    const upstream = await startHostilePostgres({ kind: 'flood' })
    servers.push(upstream)
    const certificate = selfSigned(HOST)
    const proxy = await startTlsPostgres(certificate, { host: '127.0.0.1', port: upstream.port })
    servers.push(proxy)
    const session = await openDwsiSession(
      {
        host: HOST,
        port: proxy.port,
        database: 'dwsi',
        user: 'reader',
        password: PASSWORD,
        vetted: {
          addresses: [{ address: '127.0.0.1', family: 4 }],
          privateHost: { host: HOST, databaseTls: 'verify_full', caPem: certificate.cert },
        },
        signal: new AbortController().signal,
        maxRows: 1_000_000,
      },
      { ...SESSION_LIMITS, maxSessionBytes: 2 * 1024 * 1024 },
    )
    try {
      expect(await codeOf(session.query('SELECT v', ['p']))).toBe('response_too_large')
    } finally {
      await session.close()
    }
    expect(proxy.servernames).toEqual([HOST])
    expect(upstream.sent).toBeLessThan(64 * 1024 * 1024)
  })

  it('refuses an empty password before connecting', async () => {
    const { server } = await hostile({ kind: 'rows', count: 0 })
    const session = openDwsiSession({
      host: HOST,
      port: server.port,
      database: 'dwsi',
      user: 'reader',
      password: '',
      vetted: {
        addresses: [{ address: '127.0.0.1', family: 4 }],
        privateHost: { host: HOST, databaseTls: 'plaintext', caPem: null },
      },
      signal: new AbortController().signal,
      maxRows: 1,
    })
    expect(await codeOf(session)).toBe('source_credentials_missing')
    expect(server.received).toEqual([])
  })
})
