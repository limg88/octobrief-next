import { describe, expect, it } from 'vitest'
import { type DwsiSession, pgFailure } from '../src/dwsi/session.ts'
import { DWSI_RELATIONS, DWSI_VIEWS, EMPLOYEE_VIEW, SYNC_TABLE } from '../src/dwsi/views.ts'
import {
  type ConnectorContext,
  ConnectorError,
  createDwsiConnector,
  createNetGuard,
  createSafeHttp,
  type DwsiConfig,
  dwsiConnector,
} from '../src/index.ts'
import type { PrivateHost } from '../src/private-hosts.ts'
import { SecretValue } from '../src/secret-value.ts'

// A warehouse answered in memory with the shapes the real DWSI gives through `pg` with the
// session's type parsers: 64-bit integers, numerics, dates and instants as the exact text the
// server wrote; NULLs where the real views have them (keys included); the same key twice. No
// database is needed: the connector's own checks and reading are what is under test.

const NOW = new Date('2026-11-09T09:30:00.000Z')
const CODE = 'PRJ000101'
const HOST = 'dwsi.corp.example'
const PLAINTEXT: PrivateHost = { host: HOST, databaseTls: 'plaintext', caPem: null }

type Rows = Record<string, unknown>[]

interface Warehouse {
  /** The rows of each view for the project, as the server sends them. */
  views: Record<string, Rows>
  /** What `current_setting('transaction_read_only')` answers. */
  readOnly?: string
  /** An error (as `pg` gives it) for the query of a view. */
  failing?: { view: string; error: unknown }
  /** Overrides of the declared type of a column, as `information_schema` writes it. */
  types?: Record<string, string>
}

function scripted(w: Warehouse): DwsiSession {
  const columns = [...DWSI_VIEWS, SYNC_TABLE, EMPLOYEE_VIEW].flatMap((r) =>
    r.columns.map((c) => ({
      relation: r.name,
      name: c.name,
      type: w.types?.[`${r.name}.${c.name}`] ?? c.type,
    })),
  )
  return {
    async query(text) {
      if (/^(BEGIN|ROLLBACK)/.test(text)) return []
      if (text.includes("current_setting('transaction_read_only')")) {
        return [{ read_only: w.readOnly ?? 'on' }]
      }
      if (text.includes('AS writes')) return [{ writes: false }]
      if (text.includes('pg_catalog.pg_class')) {
        return DWSI_RELATIONS.map((relation) => ({ relation }))
      }
      if (text.includes('information_schema.columns')) return columns
      if (text.startsWith('WITH me AS')) return [{ projectid: CODE }]
      if (text.includes(SYNC_TABLE.name)) {
        return [
          'TIMESHEET',
          'PROJECT',
          'SALESORDER',
          'INVOICE',
          'PROJECTREVENUE',
          'BACKLOG',
          'PROJECTPERCENTCOMPLETE',
        ].map((entity) => ({ entity, datelastsync: '2026-11-09 06:00:00.123456' }))
      }
      const view = DWSI_VIEWS.find((v) => text.includes(`dwsi."${v.name}" AS t`))
      if (view) {
        // The session gives a failure of the server as its code and SQLSTATE.
        if (w.failing?.view === view.name) throw pgFailure(w.failing.error)
        return (w.views[view.name] ?? []).map((r) => ({ projectid: CODE, ...r }))
      }
      throw new Error(`unexpected query: ${text.slice(0, 40)}`)
    },
    async close() {},
  }
}

function ctx(): ConnectorContext<DwsiConfig> {
  const config = dwsiConnector.parseConfig({
    host: HOST,
    port: 5432,
    database: 'postgres',
    user: 'reader',
    projectCodes: [CODE],
  })
  return {
    config,
    perimeter: [`prj:${CODE}`],
    secret: new SecretValue(['pw', 'of', 'the', 'test'].join('-')),
    http: createSafeHttp({ rules: [], onBlocked: async () => undefined }),
    net: createNetGuard({
      privateHosts: [PLAINTEXT],
      onBlocked: async () => undefined,
      allowLoopback: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    signal: new AbortController().signal,
    now: () => NOW,
    owner: { email: 'marta.neri@example.test', upn: null },
  }
}

const limits = { maxItems: 10, signal: new AbortController().signal }

async function syncAll(w: Warehouse) {
  const connector = createDwsiConnector({ open: async () => scripted(w) })
  const first = await connector.sync(ctx(), null, limits)
  const second = first.done ? null : await connector.sync(ctx(), first.nextCursor, limits)
  return [...(first.extractions ?? []), ...(second?.extractions ?? [])]
}

async function failure(w: Warehouse): Promise<ConnectorError> {
  try {
    await syncAll(w)
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError)
    return error as ConnectorError
  }
  throw new Error('expected a connector failure')
}

/** The rows of a pilot-like project: what the real views give, NULLs and repeats included. */
const REAL: Warehouse = {
  views: {
    v_timesheet_all: [
      {
        internalid: '9007199254740993',
        employee: 'Marta Neri',
        timesheetdate: '2026-11-02',
        duration: '7.5000',
        laborcosthh_new: '31.2500',
        laborcost_new: '234.3750',
      },
      { internalid: '9007199254740994', employee: 'Marta Neri', timesheetdate: '2026-11-03' },
    ],
    v_project: [{ name: 'Apollo', projectmanager: 'Marta Neri', plannedwork: 120.5 }],
    v_sales_order_all: [
      { salesorderid: 'SO-1', lineid: 1, amount: 1000.1, closed: 'F' },
      { salesorderid: 'SO-1', lineid: null, amount: 0 },
    ],
    v_invoice_all: [
      { invoiceid: 'INV-1', lineid: null, amount: '500.0000', invoicedate: '2026-10-31' },
      { invoiceid: 'INV-1', lineid: null, amount: '20.0000', invoicedate: '2026-10-31' },
    ],
    v_project_revenue_all: [
      { anno: 2026, mese: 10, itemgroup: 'Servizi', revenue: '1000.0000' },
      { anno: null, mese: null, itemgroup: null, revenue: '3.0000' },
    ],
    v_database_pl_all: [{ anno: null, mese: null, revenue: '1.0000' }],
    v_backlog_all: [
      { backlogrefperiod: '2026-10-01', amount: '100.0000' },
      { backlogrefperiod: null, amount: '50.0000' },
      { backlogrefperiod: null, amount: '25.0000' },
    ],
    dw_prod_projectpercentcomplete: [
      { period: 'Oct 2026', perioddate: '2026-10-31', percentcomplete: 0.4 },
      { period: null, perioddate: null, percentcomplete: 0.1 },
      { period: '', perioddate: null, percentcomplete: 0.2 },
    ],
  },
}

describe('a DWSI sync of a warehouse with the shapes of the real one', () => {
  it('extracts every view, a row whose key columns are empty kept under a key of its own', async () => {
    const extractions = await syncAll(REAL)
    expect(extractions.map((x) => x.view).sort()).toEqual(DWSI_VIEWS.map((v) => v.name).sort())
    for (const x of extractions) {
      const keys = x.rows.map((r) => r.key)
      expect(keys.every((k) => k.length > 0 && k.length <= 512)).toBe(true)
      expect(new Set(keys).size).toBe(keys.length)
    }
    const rows = (view: string) => extractions.find((x) => x.view === view)?.rows ?? []
    expect(rows('v_backlog_all')).toHaveLength(3)
    expect(rows('dw_prod_projectpercentcomplete')).toHaveLength(3)
    expect(rows('v_invoice_all')).toHaveLength(2)
    // The values stay as the warehouse wrote them: nothing deduced for an empty key.
    expect(rows('v_backlog_all').map((r) => r.values.backlogrefperiod)).toEqual([
      '2026-10-01',
      null,
      null,
    ])
  })

  it('keeps 64-bit ids, numerics and dates as the exact text the warehouse wrote', async () => {
    const extractions = await syncAll(REAL)
    const timesheet = extractions.find((x) => x.view === 'v_timesheet_all')
    expect(timesheet?.rows[0]).toMatchObject({
      key: '9007199254740993',
      values: { internalid: '9007199254740993', timesheetdate: '2026-11-02', duration: '7.5000' },
    })
  })

  it('keeps a key the warehouse wrote that looks like a repeat apart from a real repeat', async () => {
    const extractions = await syncAll({
      views: {
        dw_prod_projectpercentcomplete: [
          { period: 'Oct 2026' },
          { period: 'Oct 2026' },
          { period: 'Oct 2026#2' },
        ],
      },
    })
    const keys = extractions
      .find((x) => x.view === 'dw_prod_projectpercentcomplete')
      ?.rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(3)
  })
})

describe('a DWSI sync that fails says which check failed, never a value', () => {
  it('names the read-only check the server did not confirm', async () => {
    const error = await failure({ ...REAL, readOnly: 'off' })
    expect(error.code).toBe('source_bad_response')
    expect(error.reason).toBe('read_only_unverified')
  })

  it('names the column whose type changed', async () => {
    const error = await failure({ ...REAL, types: { 'v_backlog_all.amount': 'text' } })
    expect(error.code).toBe('definition_changed')
    expect(error.reason).toBe('column_type:v_backlog_all.amount')
  })

  it('names the SQLSTATE and the view of an error of the warehouse, never its message', async () => {
    const error = await failure({
      ...REAL,
      failing: {
        view: 'v_project_revenue_all',
        error: Object.assign(new Error('division by zero near «Apollo» 1234.56'), {
          code: '22012',
        }),
      },
    })
    expect(error.code).toBe('source_bad_response')
    expect(error.reason).toBe('sqlstate_22012:v_project_revenue_all')
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/Apollo|1234/)
  })

  it('names the view and column of a value of a kind it does not read, never the value', async () => {
    const error = await failure({
      views: { v_timesheet_all: [{ internalid: '1', timesheetdate: new Date(NOW) }] },
    })
    expect(error.code).toBe('source_bad_response')
    expect(error.reason).toBe('value_kind:v_timesheet_all.timesheetdate')
  })

  it('names the view whose key is too long to be one', async () => {
    const error = await failure({
      views: { dw_prod_projectpercentcomplete: [{ period: 'x'.repeat(600) }] },
    })
    expect(error.code).toBe('source_bad_response')
    expect(error.reason).toBe('key_too_long:dw_prod_projectpercentcomplete')
  })
})
