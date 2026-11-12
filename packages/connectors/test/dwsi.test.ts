import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DwsiSession, SessionTarget } from '../src/dwsi/session.ts'
import { openDwsiSession } from '../src/dwsi/session.ts'
import {
  type BlockedCall,
  type ConnectorContext,
  ConnectorError,
  createDwsiConnector,
  createNetGuard,
  createSafeHttp,
  type DwsiConfig,
  type DwsiCursor,
  dwsiConnector,
  type ExternalItem,
  type ResolvedAddress,
  type SyncBatch,
} from '../src/index.ts'
import type { PrivateHost } from '../src/private-hosts.ts'
import { SecretValue } from '../src/secret-value.ts'
import { type DwsiAccount, type FakeDwsi, startFakeDwsi } from './support/fake-dwsi.ts'
import { selfSigned, signedByAuthority, startTlsPostgres } from './support/tls-postgres.ts'

const NOW = new Date('2026-11-05T09:30:00.000Z')
const APOLLO = 'prj:PRJ000101'
const BOREA = 'prj:PRJ000202'
const HOST = 'dwsi.corp.example'
const PLAINTEXT: PrivateHost = { host: HOST, databaseTls: 'plaintext', caPem: null }

let fake: FakeDwsi
beforeAll(async () => {
  fake = await startFakeDwsi()
})
afterAll(async () => {
  await fake?.drop()
})

interface CtxOptions {
  account?: DwsiAccount
  secret?: SecretValue | null
  port?: number
  privateHosts?: PrivateHost[]
  resolve?: (host: string) => Promise<ResolvedAddress[]>
  blocked?: BlockedCall[]
  now?: Date
  /** The email of the PM who owns the source (null: not known). */
  owner?: string | null
  /** The UPN of the PM who owns the source. */
  upn?: string | null
}

const toLoopback = async (): Promise<ResolvedAddress[]> => [{ address: '127.0.0.1', family: 4 }]

function ctx(perimeter: string[], o: CtxOptions = {}): ConnectorContext<DwsiConfig> {
  const account = o.account ?? fake.reader
  const config = dwsiConnector.parseConfig({
    host: HOST,
    port: o.port ?? fake.port,
    database: fake.database,
    user: account.user,
    projectCodes: ['PRJ000202', 'PRJ000101', 'PRJ000999'],
  })
  const onBlocked = async (call: BlockedCall) => {
    o.blocked?.push(call)
  }
  return {
    config,
    perimeter,
    secret: o.secret === undefined ? new SecretValue(account.password) : o.secret,
    http: createSafeHttp({ rules: [], onBlocked }),
    net: createNetGuard({
      privateHosts: o.privateHosts ?? [PLAINTEXT],
      onBlocked,
      allowLoopback: true,
      resolve: o.resolve ?? toLoopback,
    }),
    signal: new AbortController().signal,
    now: () => o.now ?? NOW,
    // The PM who owns the source: Marta Neri manages Apollo and wrote hours on Borea.
    owner: {
      email: o.owner === undefined ? 'marta.neri@example.test' : o.owner,
      upn: o.upn ?? null,
    },
  }
}

const limits = (maxItems: number) => ({ maxItems, signal: new AbortController().signal })

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError)
    return (error as ConnectorError).code
  }
  throw new Error('expected a connector failure')
}

const text = (item: ExternalItem | undefined) => new TextDecoder().decode(item?.bytes)

/** A connector whose sessions record every statement they run. */
function spied() {
  const statements: string[] = []
  const connector = createDwsiConnector({
    open: async (target: SessionTarget): Promise<DwsiSession> => {
      const session = await openDwsiSession(target)
      return {
        query: (sql, params) => {
          statements.push(sql)
          return session.query(sql, params)
        },
        close: () => session.close(),
      }
    },
  })
  return { connector, statements }
}

describe('the DWSI configuration', () => {
  it('names the warehouse by host, never by address, and the declared project codes', () => {
    const config = dwsiConnector.parseConfig({
      host: 'DWSI.Corp.Example',
      database: 'dwsi',
      user: 'octobrief_ro',
      projectCodes: ['PRJ000202', 'PRJ000101'],
    })
    expect(config).toEqual({
      host: 'dwsi.corp.example',
      port: 5432,
      database: 'dwsi',
      user: 'octobrief_ro',
      projectCodes: ['PRJ000101', 'PRJ000202'],
    })
  })

  it('accepts a private IPv4 address as the host', () => {
    const raw = { host: '10.0.0.5', database: 'dwsi', user: 'ro', projectCodes: ['PRJ000101'] }
    expect(dwsiConnector.parseConfig(raw)).toMatchObject({ host: '10.0.0.5' })
  })

  it.each([
    ['a public IP address', { host: '93.184.216.34' }],
    ['a port in the host', { host: 'dwsi.corp.example:5432' }],
    ['a bad port', { port: 70_000 }],
    ['a database name with a quote', { database: 'dw"si' }],
    ['a project code of another shape', { projectCodes: ['PRJ-1'] }],
    ['no project code', { projectCodes: [] }],
    ['the same code twice', { projectCodes: ['PRJ000101', 'PRJ000101'] }],
  ])('refuses %s', (_label, change) => {
    const raw = {
      host: HOST,
      database: 'dwsi',
      user: 'octobrief_ro',
      projectCodes: ['PRJ000101'],
      ...change,
    }
    expect(() => dwsiConnector.parseConfig(raw)).toThrow(ConnectorError)
  })

  it('reaches the warehouse with no HTTP call at all', () => {
    expect(dwsiConnector.rules(ctx([APOLLO]).config)).toEqual([])
  })

  it('reads its cursor and refuses anything else', () => {
    expect(dwsiConnector.parseCursor(null)).toBeNull()
    expect(dwsiConnector.parseCursor({ done: ['PRJ000101:timesheet'] })).toEqual({
      done: ['PRJ000101:timesheet'],
    })
    for (const bad of [{}, { done: ['x'] }, { done: 'PRJ000101:timesheet' }]) {
      expect(() => dwsiConnector.parseCursor(bad)).toThrow()
    }
  })
})

describe('the DWSI account', () => {
  it('connects when it only reads', async () => {
    expect(await dwsiConnector.test(ctx([APOLLO]))).toEqual({ ok: true })
  })

  it.each([
    ['may insert into a view', 'writer'],
    ['may update a column of a view', 'columnWriter'],
    ['owns a view', 'viewOwner'],
    ['is a superuser', 'superuser'],
    ['is a member, even without inheriting, of a role that writes', 'writerMember'],
    ['may create roles', 'roleCreator'],
  ] as const)('is refused when it %s, before any data is read', async (_label, who) => {
    const { connector, statements } = spied()
    expect(await connector.test(ctx([APOLLO], { account: fake[who] }))).toEqual({
      ok: false,
      code: 'write_scope_refused',
    })
    expect(
      await codeOf(connector.sync(ctx([APOLLO], { account: fake[who] }), null, limits(10))),
    ).toBe('write_scope_refused')
    expect(statements.some((s) => s.includes('v_timesheet_all" AS t'))).toBe(false)
  })

  it('works in a read-only transaction that is rolled back, with fixed queries only', async () => {
    const { connector, statements } = spied()
    await connector.sync(ctx([APOLLO]), null, limits(10))
    expect(statements[0]).toBe('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ')
    expect(statements.at(-1)).toBe('ROLLBACK')
    for (const s of statements.slice(1, -1)) expect(s).toMatch(/^(?:SELECT|WITH me AS \(SELECT) /)
    // The project code travels as a parameter, never in the text.
    expect(statements.join('\n')).not.toContain('PRJ000101')
    // The columns never read are not even named.
    for (const column of ['memo', 'smartworking', 'reperibilita', 'salesrep', 'comments']) {
      expect(statements.join('\n')).not.toContain(`"${column}"`)
    }
  })

  it('opens sessions that are read-only by default', async () => {
    const c = ctx([APOLLO])
    const session = await openDwsiSession({
      host: HOST,
      port: fake.port,
      database: fake.database,
      user: fake.reader.user,
      password: fake.reader.password,
      vetted: await c.net.vet(HOST, fake.port, 'POSTGRES'),
      signal: c.signal,
      maxRows: 10,
    })
    try {
      expect(await session.query('SHOW default_transaction_read_only')).toEqual([
        { default_transaction_read_only: 'on' },
      ])
      // Even a temporary table, which the account may create, is refused: the session only reads.
      expect(await codeOf(session.query('CREATE TEMP TABLE x (a int)'))).toBe('source_bad_response')
      expect(await session.query('SHOW transaction_read_only')).toEqual([
        { transaction_read_only: 'on' },
      ])
    } finally {
      await session.close()
    }
  })

  it('fails with a code, never with the password', async () => {
    const wrong = new SecretValue('not-the-password')
    const error = await dwsiConnector
      .sync(ctx([APOLLO], { secret: wrong }), null, limits(10))
      .catch((e: unknown) => e)
    expect((error as ConnectorError).code).toBe('source_auth_failed')
    expect(String(error)).not.toContain('not-the-password')
    expect(JSON.stringify(error)).not.toContain('not-the-password')
    expect(await codeOf(dwsiConnector.sync(ctx([APOLLO], { secret: null }), null, limits(1)))).toBe(
      'source_credentials_missing',
    )
  })

  it('uses the password of the secret only, never one from the environment', async () => {
    const saved = process.env.PGPASSWORD
    process.env.PGPASSWORD = fake.reader.password
    try {
      expect(
        await codeOf(dwsiConnector.sync(ctx([APOLLO], { secret: null }), null, limits(1))),
      ).toBe('source_credentials_missing')
      const wrong = new SecretValue('not-the-password')
      expect(
        await codeOf(dwsiConnector.sync(ctx([APOLLO], { secret: wrong }), null, limits(1))),
      ).toBe('source_auth_failed')
    } finally {
      if (saved === undefined) delete process.env.PGPASSWORD
      else process.env.PGPASSWORD = saved
    }
  })

  it('is unreachable when nothing listens', async () => {
    expect(await codeOf(dwsiConnector.sync(ctx([APOLLO], { port: 1 }), null, limits(1)))).toBe(
      'source_unreachable',
    )
  })
})

describe('the way to the warehouse', () => {
  it('refuses a host the Admin did not list, private or public, and audits it', async () => {
    for (const address of ['10.20.0.7', '93.184.216.34']) {
      const blocked: BlockedCall[] = []
      const resolve = async (): Promise<ResolvedAddress[]> => [{ address, family: 4 }]
      const c = ctx([APOLLO], { privateHosts: [], resolve, blocked })
      expect(await codeOf(dwsiConnector.sync(c, null, limits(1)))).toBe('call_blocked')
      expect(blocked).toEqual([
        { reason: 'host_not_allowed', method: 'POSTGRES', host: `${HOST}:${fake.port}`, path: '' },
      ])
    }
  })

  it('never reaches the metadata or a link-local address, even for an allowed host', async () => {
    for (const address of ['169.254.169.254', 'fe80::1']) {
      const blocked: BlockedCall[] = []
      const resolve = async (): Promise<ResolvedAddress[]> => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]
      const c = ctx([APOLLO], { resolve, blocked })
      expect(await codeOf(dwsiConnector.sync(c, null, limits(1)))).toBe('call_blocked')
      expect(blocked).toHaveLength(1)
    }
  })

  describe('over TLS', () => {
    const upstream = () => ({ host: fake.host, port: fake.port })

    it('verifies the certificate against the host name with the Admin authority', async () => {
      const certificate = selfSigned(HOST)
      const proxy = await startTlsPostgres(certificate, upstream())
      try {
        const verified: PrivateHost = {
          host: HOST,
          databaseTls: 'verify_full',
          caPem: certificate.cert,
        }
        const c = ctx([APOLLO], { port: proxy.port, privateHosts: [verified] })
        const batch = await dwsiConnector.sync(c, null, limits(10))
        expect(batch.items).toHaveLength(2)
        // The connection went to the vetted address, named for the host.
        expect(proxy.servernames.every((name) => name === HOST)).toBe(true)
      } finally {
        await proxy.close()
      }
    })

    it('trusts a certificate signed by the company authority the Admin gave', async () => {
      const company = signedByAuthority(HOST)
      for (const { served, caPem } of [
        // The Admin pasted the issuing authority and the root; the server sends its own only.
        { served: company.cert, caPem: company.chain },
        // The Admin pasted the root only; the server sends the issuing authority too.
        { served: company.cert + company.chain, caPem: company.root },
      ]) {
        const proxy = await startTlsPostgres({ key: company.key, cert: served }, upstream())
        try {
          const verified: PrivateHost = { host: HOST, databaseTls: 'verify_full', caPem }
          const c = ctx([APOLLO], { port: proxy.port, privateHosts: [verified] })
          expect((await dwsiConnector.sync(c, null, limits(10))).items).toHaveLength(2)
          // Without the authority the same server is not trusted.
          const unknown: PrivateHost = { ...verified, caPem: null }
          const without = ctx([APOLLO], { port: proxy.port, privateHosts: [unknown] })
          expect(await codeOf(dwsiConnector.sync(without, null, limits(1)))).toBe(
            'tls_not_verified',
          )
        } finally {
          await proxy.close()
        }
      }
    })

    it('refuses a certificate it cannot verify', async () => {
      const certificate = selfSigned(HOST)
      const other = selfSigned('other.example')
      const proxy = await startTlsPostgres(certificate, upstream())
      try {
        for (const privateHosts of [
          // No authority given: the system's authorities do not know a self-signed one.
          [{ host: HOST, databaseTls: 'verify_full', caPem: null } as PrivateHost],
          // An authority that did not sign it.
          [{ host: HOST, databaseTls: 'verify_full', caPem: other.cert } as PrivateHost],
        ]) {
          const c = ctx([APOLLO], { port: proxy.port, privateHosts })
          expect(await codeOf(dwsiConnector.sync(c, null, limits(1)))).toBe('tls_not_verified')
        }
      } finally {
        await proxy.close()
      }
    })

    it('refuses a certificate for another name', async () => {
      const certificate = selfSigned('other.example')
      const proxy = await startTlsPostgres(certificate, upstream())
      try {
        const verified: PrivateHost = {
          host: HOST,
          databaseTls: 'verify_full',
          caPem: certificate.cert,
        }
        const c = ctx([APOLLO], { port: proxy.port, privateHosts: [verified] })
        expect(await codeOf(dwsiConnector.sync(c, null, limits(1)))).toBe('tls_not_verified')
      } finally {
        await proxy.close()
      }
    })

    it('accepts an unverified certificate only when the Admin allows it for the host', async () => {
      const proxy = await startTlsPostgres(selfSigned(HOST), upstream())
      try {
        const unverified: PrivateHost = { host: HOST, databaseTls: 'unverified', caPem: null }
        const c = ctx([APOLLO], { port: proxy.port, privateHosts: [unverified] })
        expect((await dwsiConnector.sync(c, null, limits(10))).items).toHaveLength(2)
      } finally {
        await proxy.close()
      }
    })

    it('refuses a server without TLS unless the Admin allows plain text for the host', async () => {
      const verified: PrivateHost = { host: HOST, databaseTls: 'verify_full', caPem: null }
      const c = ctx([APOLLO], { privateHosts: [verified] })
      expect(await codeOf(dwsiConnector.sync(c, null, limits(1)))).toBe('tls_not_verified')
      expect((await dwsiConnector.sync(ctx([APOLLO]), null, limits(10))).items).toHaveLength(2)
    })
  })
})

describe('the DWSI perimeter', () => {
  it('lists the declared project codes the warehouse knows and binds to the PM, with their names', async () => {
    await fake.exec(
      `INSERT INTO dwsi.base_project (projectid, "name") VALUES ('PRJ000303', 'Non dichiarato')`,
    )
    expect(await dwsiConnector.perimeterOptions(ctx([]))).toEqual([
      { id: APOLLO, label: 'PRJ000101 · Apollo' },
      { id: BOREA, label: 'PRJ000202 · Borea' },
    ])
  })

  it('reads only the chosen projects among the declared ones', async () => {
    const batch = await dwsiConnector.sync(
      ctx([BOREA, 'prj:PRJ000303', 'area-x']),
      null,
      limits(10),
    )
    expect(batch.items.map((i) => i.perimeter)).toEqual([[BOREA], [BOREA]])
    expect(await codeOf(dwsiConnector.sync(ctx(['prj:PRJ000303']), null, limits(1)))).toBe(
      'source_not_configured',
    )
  })
})

describe('the DWSI perimeter bound to the PM who owns the source', () => {
  const ids = (options: { id: string }[]) => options.map((o) => o.id)

  it('offers only the codes the PM manages or wrote hours on, never the name of another', async () => {
    // Luca Bassi manages Borea only; Anna Riva wrote hours on Apollo only; the email is matched
    // whatever its letter case.
    const luca = await dwsiConnector.perimeterOptions(ctx([], { owner: 'Luca.Bassi@example.test' }))
    expect(luca).toEqual([{ id: BOREA, label: 'PRJ000202 · Borea' }])
    expect(JSON.stringify(luca)).not.toContain('Apollo')
    expect(
      ids(await dwsiConnector.perimeterOptions(ctx([], { owner: 'anna.riva@example.test' }))),
    ).toEqual([APOLLO])
    // Not bound to anything, or not known: nothing is offered.
    for (const owner of ['ugo@example.test', 'nobody@example.test', null]) {
      expect(await dwsiConnector.perimeterOptions(ctx([], { owner }))).toEqual([])
    }
  })

  it('never names a person or the email in a query, nor any other column of the employees', async () => {
    const { connector, statements } = spied()
    await connector.perimeterOptions(ctx([]))
    await connector.sync(ctx([APOLLO]), null, limits(10))
    const all = statements.join('\n')
    for (const word of ['marta', 'Marta', 'example.test']) expect(all).not.toContain(word)
    for (const column of ['altemail', 'birthdate', 'phone', 'laborcost', 'jobtitle']) {
      expect(all).not.toContain(`"${column}"`)
    }
  })

  it('binds nothing through a name another employee bears too (a namesake)', async () => {
    await fake.exec(
      `INSERT INTO dwsi.base_employee (internalid, "name", email) VALUES (90, 'Luca Bassi', 'altro.luca@example.test'),
       (91, 'Anna Riva', NULL)`,
    )
    try {
      for (const owner of [
        'luca.bassi@example.test',
        'altro.luca@example.test',
        'anna.riva@example.test',
      ]) {
        expect(await dwsiConnector.perimeterOptions(ctx([], { owner }))).toEqual([])
      }
      // The same person recorded twice with the same email still binds.
      await fake.exec(
        `INSERT INTO dwsi.base_employee (internalid, "name", email) VALUES (92, 'Carla Fumi', 'CARLA.FUMI@example.test')`,
      )
      expect(
        ids(await dwsiConnector.perimeterOptions(ctx([], { owner: 'carla.fumi@example.test' }))),
      ).toEqual([BOREA])
    } finally {
      await fake.exec('DELETE FROM dwsi.base_employee WHERE internalid IN (90, 91, 92)')
    }
  })

  it('knows the PM by their UPN as well as their email, a namesake by either address', async () => {
    const as = (email: string | null, upn: string | null) => ctx([], { owner: email, upn })
    // The warehouse writes the mail address; the UPN differs.
    expect(
      ids(
        await dwsiConnector.perimeterOptions(as('luca.bassi@example.test', 'l.bassi@corp.example')),
      ),
    ).toEqual([BOREA])
    // The warehouse writes the UPN; the login's email differs.
    expect(
      ids(
        await dwsiConnector.perimeterOptions(as('scelta@altro.example', 'Luca.Bassi@example.test')),
      ),
    ).toEqual([BOREA])
    await fake.exec(
      `INSERT INTO dwsi.base_employee (internalid, "name", email) VALUES (93, 'Luca Bassi', 'l.bassi@corp.example')`,
    )
    try {
      // The same person under both addresses binds only who has both.
      expect(
        ids(
          await dwsiConnector.perimeterOptions(
            as('luca.bassi@example.test', 'l.bassi@corp.example'),
          ),
        ),
      ).toEqual([BOREA])
      expect(await dwsiConnector.perimeterOptions(as('luca.bassi@example.test', null))).toEqual([])
      expect(await dwsiConnector.perimeterOptions(as(null, 'l.bassi@corp.example'))).toEqual([])
    } finally {
      await fake.exec('DELETE FROM dwsi.base_employee WHERE internalid = 93')
    }
  })

  it('refuses a typed code the PM is not bound to: it is never read', async () => {
    const asLuca = (perimeter: string[]) => ctx(perimeter, { owner: 'luca.bassi@example.test' })
    expect(await codeOf(dwsiConnector.sync(asLuca([APOLLO]), null, limits(10)))).toBe(
      'source_not_authorized',
    )
    const batch = await dwsiConnector.sync(asLuca([APOLLO, BOREA]), null, limits(10))
    expect(batch.items.map((i) => i.perimeter)).toEqual([[BOREA], [BOREA]])
    expect(JSON.stringify(batch.extractions)).not.toContain('PRJ000101')
    expect(batch.skipped).toEqual({ code_not_bound: 1 })
    expect(await codeOf(dwsiConnector.sync(ctx([APOLLO], { owner: null }), null, limits(10)))).toBe(
      'source_not_authorized',
    )
  })

  it('checks the binding again at every sync: a code no longer bound is dropped and counted', async () => {
    const both = ctx([APOLLO, BOREA])
    const first = await dwsiConnector.sync(both, null, limits(10))
    expect(new Set(first.items.map((i) => i.perimeter[0]))).toEqual(new Set([APOLLO, BOREA]))
    expect(first.skipped).toBeUndefined()
    await fake.exec(`DELETE FROM dwsi.base_timesheet WHERE internalid = 9004`)
    try {
      const again = await dwsiConnector.sync(both, null, limits(10))
      expect(again.items.map((i) => i.perimeter)).toEqual([[APOLLO], [APOLLO]])
      expect(again.skipped).toEqual({ code_not_bound: 1 })
    } finally {
      await fake.exec(
        `INSERT INTO dwsi.base_timesheet VALUES (9004, 'IT', 'Marta Neri', '2026-10-07', 'PRJ000202',
         'Supporto', NULL, NULL, NULL, 'OR', 1.0000, 'Approved', 45.0000, 45.0000)`,
      )
    }
  })
})

describe('a DWSI extraction', () => {
  let batch: SyncBatch<DwsiCursor>
  beforeAll(async () => {
    batch = await dwsiConnector.sync(ctx([APOLLO]), null, limits(10))
  })

  it('gives the hours and the economics of the project as system evidence', () => {
    expect(
      batch.items.map((i) => ({
        externalId: i.externalId,
        version: i.version,
        title: i.title,
        mediaType: i.mediaType,
        kind: i.kind,
        perimeter: i.perimeter,
      })),
    ).toEqual([
      {
        externalId: 'dwsi:PRJ000101:timesheet',
        version: NOW.toISOString(),
        title: 'Estrazione DWSI · Ore · PRJ000101 del 05/11 10:30',
        mediaType: 'text/markdown',
        kind: 'timesheet',
        perimeter: [APOLLO],
      },
      {
        externalId: 'dwsi:PRJ000101:economics',
        version: NOW.toISOString(),
        title: 'Estrazione DWSI · Dati economici · PRJ000101 del 05/11 10:30',
        mediaType: 'text/markdown',
        kind: 'economics_export',
        perimeter: [APOLLO],
      },
    ])
    expect(batch.done).toBe(true)
    expect(batch.nextCursor).toEqual({ done: ['PRJ000101:timesheet', 'PRJ000101:economics'] })
  })

  it('dates the data by the older of the extraction and the last sync of the warehouse', () => {
    const [hours, economics] = batch.items
    expect(hours?.originAt).toEqual(new Date('2026-11-05T06:00:00.000Z'))
    // The oldest of the economics entities: the sales orders.
    expect(economics?.originAt).toEqual(new Date('2026-11-04T22:00:00.000Z'))
    expect(batch.dataAsOf).toEqual(new Date('2026-11-04T22:00:00.000Z'))
    const synced = Object.fromEntries(
      (batch.extractions ?? []).map((e) => [e.view, e.sourceSyncedAt?.toISOString() ?? null]),
    )
    expect(synced).toEqual({
      v_timesheet_all: '2026-11-05T06:00:00.000Z',
      v_project: '2026-11-05T06:10:00.250Z',
      v_sales_order_all: '2026-11-04T22:00:00.000Z',
      v_invoice_all: '2026-11-04T22:05:00.000Z',
      v_project_revenue_all: '2026-11-04T23:00:00.000Z',
      // No entity of the warehouse dates the P&L: not deduced.
      v_database_pl_all: null,
      v_backlog_all: '2026-11-04T23:30:00.000Z',
      dw_prod_projectpercentcomplete: '2026-11-05T05:00:00.000Z',
    })
    expect(batch.extractions?.every((e) => e.extractedAt.getTime() === NOW.getTime())).toBe(true)
  })

  it('gives the rows of each view with their keys, as the warehouse wrote them', () => {
    const of = (view: string) => batch.extractions?.find((e) => e.view === view)
    expect(of('v_timesheet_all')).toMatchObject({
      evidenceExternalId: 'dwsi:PRJ000101:timesheet',
      perimeter: APOLLO,
      rows: [
        {
          key: '9001',
          values: {
            internalid: '9001',
            projectid: 'PRJ000101',
            employee: 'Anna Riva',
            timesheetdate: '2026-10-05',
            casetaskevent: 'Analisi',
            tipoore: 'OR',
            duration: '7.5000',
            approvalstatus: 'Approved',
            laborcosthh_new: '41.2000',
            laborcost_new: '309.0000',
          },
        },
        { key: '9002', values: { employee: 'Bruno Sala', duration: '8.0000' } },
      ],
    })
    expect(of('v_sales_order_all')?.rows).toEqual([
      expect.objectContaining({
        key: 'SO-17|1',
        values: expect.objectContaining({ lineid: 1, amount: 98000, closed: false }),
      }),
    ])
    // Two rows share a key: the second has a rank.
    expect(of('v_project_revenue_all')?.rows.map((r) => r.key)).toEqual([
      '2026|9|Labor',
      '2026|9|Labor#2',
    ])
    expect(of('dw_prod_projectpercentcomplete')?.rows[0]?.values.percentcomplete).toBe(0.53)
    // The other project's hours never come.
    expect(JSON.stringify(batch.extractions)).not.toContain('Carla Fumi')
  })

  it('never reads personal notes, sales representatives or comments', () => {
    const all = `${JSON.stringify(batch.extractions)}${batch.items.map(text).join('')}`
    for (const value of ['nota privata', 'memo interno', 'Rino Venditti', 'commento']) {
      expect(all).not.toContain(value)
    }
    for (const row of batch.extractions?.flatMap((e) => e.rows) ?? []) {
      expect(Object.keys(row.values)).not.toContain('memo')
    }
  })

  it('lists the rows in its evidence, a section per view, without the time of the read', () => {
    const hours = text(batch.items[0])
    expect(hours).toContain('# Estrazione DWSI · Ore · PRJ000101')
    expect(hours).toContain('## Ore (timesheet) (`v_timesheet_all`)')
    expect(hours).toContain('| 9001 | PRJ000101 | Anna Riva | 2026-10-05 | Analisi |')
    // A cell that would break the table is escaped.
    expect(hours).toContain('=SUM(A1)\\|x')
    expect(hours).not.toContain('2026-11-05T09:30')
    const economics = text(batch.items[1])
    for (const heading of [
      'Progetto',
      'Ordini',
      'Fatture',
      'Ricavi e costi mensili',
      'Conto economico mensile',
      'Backlog',
      'Avanzamento',
    ]) {
      expect(economics).toContain(`## ${heading} (`)
    }
  })

  it('carries the people it names, to be made people later', () => {
    expect(batch.items[0]?.people).toEqual([
      { displayName: 'Anna Riva' },
      { displayName: 'Bruno Sala' },
    ])
    expect(batch.items[1]?.people).toEqual([{ displayName: 'Marta Neri' }])
  })

  it('is the same evidence when the data did not change', async () => {
    const again = await dwsiConnector.sync(
      ctx([APOLLO], { now: new Date('2026-11-05T11:00:00Z') }),
      null,
      limits(10),
    )
    expect(again.items.map(text)).toEqual(batch.items.map(text))
    expect(again.items[0]?.version).not.toBe(batch.items[0]?.version)
  })

  it('differs from project to project, even without rows', async () => {
    const borea = await dwsiConnector.sync(ctx([BOREA]), null, limits(10))
    expect(text(borea.items[1])).not.toEqual(text(batch.items[1]))
    expect(text(borea.items[1])).toContain('PRJ000202')
  })
})

describe('a DWSI extraction from a warehouse with the types of the real one', () => {
  it('reads the closing of an order line written as text, leaving any other word not deduced', async () => {
    await fake.exec(`
      INSERT INTO dwsi.base_sales_order VALUES
        ('SO-90', 1, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', 'T', NULL),
        ('SO-90', 2, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', ' yes ', NULL),
        ('SO-90', 3, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', 'N', NULL),
        ('SO-90', 4, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', '0', NULL),
        ('SO-90', 5, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', NULL, NULL),
        ('SO-90', 6, '2026-02-01', 'Billed', 'Servizi', 1, 10, 0, 'PRJ000202', 'boh', NULL);`)
    try {
      const batch = await dwsiConnector.sync(ctx([BOREA]), null, limits(10))
      const orders = batch.extractions?.find((e) => e.view === 'v_sales_order_all')?.rows
      expect(orders?.map((r) => [r.key, r.values.closed])).toEqual([
        ['SO-90|1', true],
        ['SO-90|2', true],
        ['SO-90|3', false],
        ['SO-90|4', false],
        ['SO-90|5', null],
        ['SO-90|6', null],
      ])
    } finally {
      await fake.exec(`DELETE FROM dwsi.base_sales_order WHERE salesorderid = 'SO-90'`)
    }
  })

  it('reads whole years and months, leaving a fractional or impossible period not deduced', async () => {
    await fake.exec(`
      INSERT INTO dwsi.base_project_revenue VALUES
        ('PRJ000202', 2026.0, 10.0, 'Labor', 1, 1, 2, 2, 90, 1),
        ('PRJ000202', 2026.5, 11, 'Expense', 1, 1, 2, 2, 91, 1),
        ('PRJ000202', 2026, 13, 'License', 1, 1, 2, 2, 92, 1),
        ('PRJ000202', 'NaN', 'NaN', 'Travel', 1, 1, 2, 2, 93, 1);`)
    try {
      const batch = await dwsiConnector.sync(ctx([BOREA]), null, limits(10))
      const revenue = batch.extractions?.find((e) => e.view === 'v_project_revenue_all')?.rows
      expect(
        revenue?.map((r) => [r.values.itemgroup, r.values.anno, r.values.mese]).sort(),
      ).toEqual(
        [
          ['Labor', 2026, 10],
          ['Expense', null, 11],
          ['License', 2026, null],
          ['Travel', null, null],
        ].sort(),
      )
      expect(text(batch.items[1])).toContain('| PRJ000202 | 2026 | 10 | Labor |')
      expect(text(batch.items[1])).not.toContain('2026.5')
    } finally {
      await fake.exec(`DELETE FROM dwsi.base_project_revenue WHERE projectid = 'PRJ000202'`)
    }
  })

  it('gives floating-point amounts as the decimals the warehouse meant, in rows and evidence', async () => {
    await fake.exec(`
      INSERT INTO dwsi.base_sales_order VALUES
        ('SO-91', 1, '2026-02-01', 'Open', 'Servizi', 3, 0.1::float8 + 0.2::float8,
         45000.1::float8 * 3, 'PRJ000202', 'F', NULL);`)
    try {
      const batch = await dwsiConnector.sync(ctx([BOREA]), null, limits(10))
      const [line] = batch.extractions?.find((e) => e.view === 'v_sales_order_all')?.rows ?? []
      expect(line?.values).toMatchObject({ quantity: 3, amount: 0.3, invoiced: 135000.3 })
      const evidence = text(batch.items[1])
      expect(evidence).toContain(
        '| PRJ000202 | SO-91 | 1 | 2026-02-01 | Open | Servizi | 3 | 0.3 | 135000.3 | false |',
      )
      expect(evidence).not.toMatch(/0000000000\d|9999999999/)
    } finally {
      await fake.exec(`DELETE FROM dwsi.base_sales_order WHERE salesorderid = 'SO-91'`)
    }
  })

  it('passes the signature of the warehouse: no changed definition', async () => {
    expect(await dwsiConnector.test(ctx([APOLLO]))).toEqual({ ok: true })
    const batch = await dwsiConnector.sync(ctx([APOLLO]), null, limits(10))
    const project = batch.extractions?.find((e) => e.view === 'v_project')?.rows[0]?.values
    expect(project).toMatchObject({
      plannedwork: 1200,
      actualwork: 640.5,
      remainingwork: 559.5,
      percentcomplete: 53.375,
    })
  })
})

describe('a DWSI sync', () => {
  it('leaves the date not deduced when the warehouse does not date an entity, never the extraction', async () => {
    await fake.exec(`DELETE FROM dwsi.dw_prod_syncdata WHERE entity IN ('TIMESHEET', 'INVOICE')`)
    try {
      const undated = await dwsiConnector.sync(ctx([APOLLO]), null, limits(10))
      const [hours, economics] = undated.items
      expect(hours?.originAt).toBeNull()
      // One economic view is not dated: the category is not dated, not the oldest known date.
      expect(economics?.originAt).toBeNull()
      expect(undated.dataAsOf).toBeNull()
      const synced = Object.fromEntries(
        (undated.extractions ?? []).map((e) => [e.view, e.sourceSyncedAt?.toISOString() ?? null]),
      )
      expect(synced.v_timesheet_all).toBeNull()
      expect(synced.v_invoice_all).toBeNull()
      expect(synced.v_sales_order_all).toBe('2026-11-04T22:00:00.000Z')
    } finally {
      await fake.exec(
        `INSERT INTO dwsi.dw_prod_syncdata VALUES
           ('TIMESHEET', '2026-11-05 06:00:00'), ('INVOICE', '2026-11-04 22:05:00')`,
      )
    }
  })

  it('goes unit by unit within the batch limit, then starts a new round', async () => {
    const c = ctx([BOREA, APOLLO])
    const first = await dwsiConnector.sync(c, null, limits(3))
    expect(first.items.map((i) => i.externalId)).toEqual([
      'dwsi:PRJ000101:timesheet',
      'dwsi:PRJ000101:economics',
      'dwsi:PRJ000202:timesheet',
    ])
    expect(first.done).toBe(false)
    const second = await dwsiConnector.sync(c, first.nextCursor, limits(3))
    expect(second.items.map((i) => i.externalId)).toEqual(['dwsi:PRJ000202:economics'])
    expect(second.done).toBe(true)
    const round = await dwsiConnector.sync(c, second.nextCursor, limits(1))
    expect(round.items.map((i) => i.externalId)).toEqual(['dwsi:PRJ000101:timesheet'])
    expect(round.nextCursor).toEqual({ done: ['PRJ000101:timesheet'] })
  })

  it('refuses a view with more rows than a query reads, never truncating it', async () => {
    const small = createDwsiConnector({ maxRowsPerQuery: 1 })
    expect(await codeOf(small.sync(ctx([APOLLO]), null, limits(10)))).toBe('response_too_large')
    const two = createDwsiConnector({ maxRowsPerQuery: 2 })
    expect((await two.sync(ctx([APOLLO]), null, limits(10))).items).toHaveLength(2)
  })

  it('refuses a changed definition: a column of another type, missing, or a view gone', async () => {
    const changes: [string, string][] = [
      [
        `DROP VIEW dwsi.v_timesheet_all;
         CREATE VIEW dwsi.v_timesheet_all AS SELECT internalid, subsidiary, employee, timesheetdate,
           projectid, casetaskevent, memo, smartworking, reperibilita, tipoore,
           duration::float8 AS duration, approvalstatus, laborcosthh_new, laborcost_new
           FROM dwsi.base_timesheet;
         GRANT SELECT ON dwsi.v_timesheet_all TO ${fake.reader.user};`,
        `DROP VIEW dwsi.v_timesheet_all;
         CREATE VIEW dwsi.v_timesheet_all AS SELECT * FROM dwsi.base_timesheet;
         GRANT SELECT ON dwsi.v_timesheet_all TO ${fake.reader.user};`,
      ],
      [
        `DROP VIEW dwsi.v_database_pl_all;
         CREATE VIEW dwsi.v_database_pl_all AS SELECT projectid, anno, mese, revenue, cost_total
           FROM dwsi.base_pl;
         GRANT SELECT ON dwsi.v_database_pl_all TO ${fake.reader.user};`,
        `DROP VIEW dwsi.v_database_pl_all;
         CREATE VIEW dwsi.v_database_pl_all AS SELECT * FROM dwsi.base_pl;
         GRANT SELECT ON dwsi.v_database_pl_all TO ${fake.reader.user};`,
      ],
      [
        `REVOKE SELECT ON dwsi.dw_prod_syncdata FROM ${fake.reader.user};`,
        `GRANT SELECT ON dwsi.dw_prod_syncdata TO ${fake.reader.user};`,
      ],
    ]
    for (const [change, restore] of changes) {
      await fake.exec(change)
      try {
        expect(await codeOf(dwsiConnector.sync(ctx([APOLLO]), null, limits(10)))).toBe(
          'definition_changed',
        )
        expect(await dwsiConnector.test(ctx([APOLLO]))).toEqual({
          ok: false,
          code: 'definition_changed',
        })
      } finally {
        await fake.exec(restore)
      }
    }
    expect(await dwsiConnector.test(ctx([APOLLO]))).toEqual({ ok: true })
  })

  it('stops when the job stops', async () => {
    const stop = new AbortController()
    stop.abort(new Error('stopped'))
    const error = await dwsiConnector
      .sync(ctx([APOLLO]), null, { maxItems: 10, signal: stop.signal })
      .catch((e: unknown) => e)
    expect(String(error)).toContain('stopped')
  })
})
