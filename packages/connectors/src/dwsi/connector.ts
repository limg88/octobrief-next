import { ConnectorError } from '../errors.ts'
import type {
  Connector,
  ConnectorCheck,
  ConnectorContext,
  ExternalItem,
  ExternalPerson,
  Json,
  PerimeterOption,
  SyncBatch,
  SyncLimits,
  SystemExtraction,
  SystemRow,
} from '../port.ts'
import { cutToCharacters } from '../shared/text.ts'
import { isRecord, uniquePeople } from '../shared/values.ts'
import { codeOfOption, type DwsiConfig, parseDwsiConfig, prjOption } from './config.ts'
import { extractionDocument, extractionTitle, type ViewRows } from './evidence.ts'
import { type DwsiSession, openDwsiSession, pgFailure, type SessionTarget } from './session.ts'
import { columnValue } from './values.ts'
import {
  BOUND_CODES_QUERY,
  CATEGORIES,
  CATEGORY_KIND,
  DWSI_RELATIONS,
  DWSI_SCHEMA,
  DWSI_VIEWS,
  type DwsiCategory,
  type DwsiView,
  EMPLOYEE_VIEW,
  SYNC_TABLE,
  viewQuery,
} from './views.ts'

/** The units of the current round already extracted (`<code>:<category>`). */
export type DwsiCursor = { done: string[] } | null

/** Rows one query reads at most: beyond it the extraction is refused, never truncated. */
export const MAX_ROWS_PER_QUERY = 20_000
/** A batch takes no further unit once it holds this many rows. */
const BATCH_ROWS = 20_000
const MAX_KEY = 512
/**
 * A key column the warehouse left empty (NULL, or an empty text), in a row key: the real views
 * have such rows (a backlog line without its period, an invoice line without its number). The
 * row is kept, never dropped nor given a guessed value: its values stay empty.
 */
const NO_VALUE = '\u2205'

export interface DwsiConnectorOptions {
  /** Opens a session on the warehouse; a real `pg` connection by default. */
  open?: (target: SessionTarget) => Promise<DwsiSession>
  maxRowsPerQuery?: number
}

interface Unit {
  id: string
  code: string
  category: DwsiCategory
}

function parseCursor(raw: unknown): DwsiCursor {
  if (raw === null) return null
  if (!isRecord(raw) || !Array.isArray(raw.done) || raw.done.length > 200) {
    throw new TypeError('dwsi cursor')
  }
  const done = raw.done
  if (!done.every((u) => typeof u === 'string' && /^PRJ\d{6}:(timesheet|economics)$/.test(u))) {
    throw new TypeError('dwsi cursor')
  }
  return { done: [...done] as string[] }
}

/** The project codes to read: chosen by the PM, among those declared. */
function codesOf(ctx: ConnectorContext<DwsiConfig>): string[] {
  const declared = new Set(ctx.config.projectCodes)
  const codes = ctx.perimeter
    .map(codeOfOption)
    .filter((c): c is string => c !== null && declared.has(c))
  if (codes.length === 0) throw new ConnectorError('source_not_configured')
  return [...new Set(codes)].sort()
}

/** A `timestamp without time zone` of the warehouse, written in UTC; null when unreadable. */
export function utcInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,6})?$/.exec(value)
  if (!m) return null
  const ms = (m[3] ?? '').slice(0, 4).padEnd(4, '0')
  const at = new Date(`${m[1]}T${m[2]}${ms === '0000' ? '' : ms}Z`)
  return Number.isNaN(at.getTime()) ? null : at
}

/** The declared columns of a row, and nothing else, each read as its column says. */
function valuesOf(view: DwsiView, row: Record<string, unknown>): Record<string, Json> {
  return Object.fromEntries(
    view.columns.map((c) => [c.name, columnValue(c, row[c.name], view.name)]),
  )
}

/**
 * The rows with their keys: the key columns (an empty one written `NO_VALUE`), and a rank for
 * the rows that share one. Every key of a view is distinct, even when the warehouse wrote a key
 * that looks like a ranked one.
 */
function keyed(view: DwsiView, rows: readonly Record<string, Json>[]): SystemRow[] {
  const seen = new Map<string, number>()
  const used = new Set<string>()
  return rows.map((values) => {
    const base = view.key
      .map((k) => (values[k] === null || values[k] === '' ? NO_VALUE : String(values[k])))
      .join('|')
    let rank = seen.get(base) ?? 0
    let key: string
    do {
      rank += 1
      key = rank === 1 ? base : `${base}#${rank}`
    } while (used.has(key))
    seen.set(base, rank)
    used.add(key)
    if (key.length === 0) {
      throw new ConnectorError('source_bad_response', { reason: `key_missing:${view.name}` })
    }
    if (key.length > MAX_KEY) {
      throw new ConnectorError('source_bad_response', { reason: `key_too_long:${view.name}` })
    }
    return { key, values }
  })
}

function peopleOf(views: readonly ViewRows[]): ExternalPerson[] {
  return uniquePeople(
    views.flatMap(({ view, rows }) =>
      rows.flatMap((row) =>
        view.people
          .map((column) => row[column])
          .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
          .map((name) => ({ displayName: name.trim() })),
      ),
    ),
  )
}

/**
 * The account must only read, and so must every role it is a member of, even without inheriting
 * from it (it could switch to it): none is a superuser, may bypass row-level security or create
 * roles, owns a relation of the list (an owner can change it) or holds a privilege that writes on
 * one (insert, update, delete, truncate, triggers, references, column grants). And the
 * transaction must be read-only.
 */
async function checkAccount(session: DwsiSession): Promise<void> {
  const [state] = await session.query(
    `SELECT current_setting('transaction_read_only') AS read_only`,
  )
  if (state?.read_only !== 'on') {
    throw new ConnectorError('source_bad_response', { reason: 'read_only_unverified' })
  }
  const relations = await session.query(
    `SELECT c.relname AS relation
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${DWSI_SCHEMA}' AND c.relname = ANY ($1::text[])`,
    [DWSI_RELATIONS],
  )
  if (relations.length !== DWSI_RELATIONS.length) {
    const found = new Set(relations.map((r) => r.relation))
    const missing = DWSI_RELATIONS.find((name) => !found.has(name)) ?? 'unknown'
    throw new ConnectorError('definition_changed', { reason: `relation_missing:${missing}` })
  }
  const [verdict] = await session.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_roles r
        WHERE pg_has_role(current_user, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = '${DWSI_SCHEMA}' AND c.relname = ANY ($1::text[])
               AND (pg_has_role(r.oid, c.relowner, 'MEMBER')
                    OR has_table_privilege(r.oid, c.oid, 'INSERT')
                    OR has_table_privilege(r.oid, c.oid, 'UPDATE')
                    OR has_table_privilege(r.oid, c.oid, 'DELETE')
                    OR has_table_privilege(r.oid, c.oid, 'TRUNCATE')
                    OR has_table_privilege(r.oid, c.oid, 'TRIGGER')
                    OR has_table_privilege(r.oid, c.oid, 'REFERENCES')
                    OR has_any_column_privilege(r.oid, c.oid, 'INSERT')
                    OR has_any_column_privilege(r.oid, c.oid, 'UPDATE'))))
     ) AS writes`,
    [DWSI_RELATIONS],
  )
  if (verdict?.writes !== false) {
    throw new ConnectorError('write_scope_refused', { reason: 'account_can_write' })
  }
}

/**
 * The signature of the warehouse: every relation of the list has every declared column, with
 * its declared type. Anything missing or changed refuses the extraction (`definition_changed`):
 * nothing is read from a definition the connector does not know.
 */
async function checkSignature(session: DwsiSession): Promise<void> {
  const columns = await session.query(
    `SELECT table_name AS relation, column_name AS name, data_type AS type
       FROM information_schema.columns
      WHERE table_schema = '${DWSI_SCHEMA}' AND table_name = ANY ($1::text[])
      ORDER BY table_name, ordinal_position`,
    [DWSI_RELATIONS],
  )
  const found = new Map<string, Map<string, unknown>>()
  for (const c of columns) {
    const relation = String(c.relation)
    const of = found.get(relation) ?? new Map<string, unknown>()
    of.set(String(c.name), c.type)
    found.set(relation, of)
  }
  for (const relation of [...DWSI_VIEWS, SYNC_TABLE, EMPLOYEE_VIEW]) {
    const of = found.get(relation.name)
    if (!of) {
      throw new ConnectorError('definition_changed', {
        reason: `relation_missing:${relation.name}`,
      })
    }
    for (const c of relation.columns) {
      if (!of.has(c.name)) {
        throw new ConnectorError('definition_changed', {
          reason: `column_missing:${relation.name}.${c.name}`,
        })
      }
      if (of.get(c.name) !== c.type) {
        throw new ConnectorError('definition_changed', {
          reason: `column_type:${relation.name}.${c.name}`,
        })
      }
    }
  }
}

/** When the warehouse last synchronized each entity from NetSuite. */
async function syncDates(session: DwsiSession): Promise<Map<string, Date>> {
  const entities = [...new Set(DWSI_VIEWS.flatMap((v) => (v.syncEntity ? [v.syncEntity] : [])))]
  const rows = await session.query(
    `SELECT "entity", "datelastsync" FROM ${DWSI_SCHEMA}."${SYNC_TABLE.name}"
      WHERE "entity" = ANY ($1::text[]) ORDER BY "entity"`,
    [entities],
  )
  const dates = new Map<string, Date>()
  for (const r of rows) {
    const at = utcInstant(r.datelastsync)
    if (typeof r.entity === 'string' && at) dates.set(r.entity, at)
  }
  return dates
}

const ADDRESS = /^[^\s@]+@[^\s@]+$/

/** The addresses of the PM who owns the source (UPN and email), in lower case; none unknown. */
function ownerAddresses(ctx: ConnectorContext<DwsiConfig>): string[] {
  const all = [ctx.owner?.upn, ctx.owner?.email]
    .map((a) => a?.trim().toLowerCase() ?? '')
    .filter((a) => ADDRESS.test(a) && a.length <= 254)
  return [...new Set(all)]
}

/**
 * The codes among `codes` bound in the warehouse to the PM who owns the source: the PM is their
 * project manager or wrote hours on them (`BOUND_CODES_QUERY`), known by their UPN or email.
 * None without either.
 */
async function boundCodes(
  session: DwsiSession,
  ctx: ConnectorContext<DwsiConfig>,
  codes: readonly string[],
): Promise<Set<string>> {
  const addresses = ownerAddresses(ctx)
  if (addresses.length === 0 || codes.length === 0) return new Set()
  const rows = await session.query(BOUND_CODES_QUERY, [addresses, [...codes]])
  return new Set(
    rows
      .map((r) => r.projectid)
      .filter((c): c is string => typeof c === 'string' && codes.includes(c)),
  )
}

/** The older of two instants: the data is as old as its oldest signal. */
const older = (a: Date, b: Date | null) => (b !== null && b.getTime() < a.getTime() ? b : a)

/**
 * The read-only NetSuite connector, through the DWSI data warehouse (Postgres). A source is a
 * warehouse and the project codes a PM declared; the PM chooses the perimeter among the declared
 * codes bound in the warehouse to the PM who owns the source (project manager, or hours written
 * on it: `BOUND_CODES_QUERY`), checked again at every batch. A sync extracts, for each chosen project, its hours (timesheet) and
 * its economics (project, orders, invoices, revenue, P&L, backlog, progress) with fixed,
 * parametrized queries on the closed list of views and declared columns. Each extraction gives
 * an «Estrazione DWSI» evidence (a `timesheet` or an `economics_export`, system data, internal by
 * rule) and the rows of each view for the tools. Every session is read-only by construction:
 * reached through the network guard (pinned address, TLS named for the host), read-only by
 * default, in a `READ ONLY` transaction rolled back at the end; an account that can write, a
 * changed definition or more rows than a query reads refuse the extraction.
 */
export function createDwsiConnector(
  options: DwsiConnectorOptions = {},
): Connector<DwsiConfig, DwsiCursor> {
  const open = options.open ?? openDwsiSession
  const maxRows = options.maxRowsPerQuery ?? MAX_ROWS_PER_QUERY

  async function withSession<T>(
    ctx: ConnectorContext<DwsiConfig>,
    work: (session: DwsiSession) => Promise<T>,
  ): Promise<T> {
    const password = ctx.secret?.reveal() ?? ''
    // No password, never one from the environment or a password file.
    if (password === '') throw new ConnectorError('source_credentials_missing')
    const { host, port, database, user } = ctx.config
    const vetted = await ctx.net.vet(host, port, 'POSTGRES')
    const session = await open({
      host,
      port,
      database,
      user,
      password,
      vetted,
      signal: ctx.signal,
      maxRows: MAX_ROWS_PER_QUERY,
    })
    try {
      await session.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ')
      await checkAccount(session)
      await checkSignature(session)
      return await work(session)
    } finally {
      await session.query('ROLLBACK').catch(() => undefined)
      await session.close()
    }
  }

  async function readView(session: DwsiSession, view: DwsiView, code: string) {
    let rows: Record<string, unknown>[]
    try {
      rows = await session.query(viewQuery(view, maxRows), [code], { maxRows })
    } catch (error) {
      // Which view failed, beside the SQLSTATE: the session does not know it.
      const failed = pgFailure(error)
      const reason = failed.reason
      throw reason !== null && !reason.includes(':')
        ? new ConnectorError(failed.code, { ...failed.detail, reason: `${reason}:${view.name}` })
        : failed
    }
    if (rows.length > maxRows) throw new ConnectorError('response_too_large')
    // The query filters by project; a row of another project is dropped, never kept.
    return rows.filter((r) => r.projectid === code).map((r) => valuesOf(view, r))
  }

  return {
    kind: 'netsuite_dwsi',
    parseConfig: parseDwsiConfig,
    parseCursor,
    // The warehouse is not reached over HTTP: no call is allowed.
    rules: () => [],

    async test(ctx): Promise<ConnectorCheck> {
      try {
        await withSession(ctx, async () => undefined)
        return { ok: true }
      } catch (error) {
        if (error instanceof ConnectorError) return { ok: false, code: error.code }
        throw error
      }
    },

    /**
     * The declared codes bound to the PM who owns the source, with their names: a code the PM
     * is not bound to is never offered, and its name never read.
     */
    async perimeterOptions(ctx): Promise<PerimeterOption[]> {
      return withSession(ctx, async (session) => {
        const bound = [...(await boundCodes(session, ctx, ctx.config.projectCodes))]
        if (bound.length === 0) return []
        const rows = await session.query(
          `SELECT "projectid", "name" FROM ${DWSI_SCHEMA}."v_project"
            WHERE "projectid" = ANY ($1::text[]) ORDER BY "projectid"`,
          [bound],
        )
        return rows
          .filter((r) => typeof r.projectid === 'string' && bound.includes(r.projectid))
          .map((r) => {
            const code = r.projectid as string
            const name = typeof r.name === 'string' ? cutToCharacters(r.name.trim(), 200) : ''
            return { id: prjOption(code), label: name ? `${code} · ${name}` : code }
          })
      })
    },

    async sync(ctx, cursor, limits: SyncLimits): Promise<SyncBatch<DwsiCursor>> {
      const chosen = codesOf(ctx)
      const extractedAt = ctx.now()

      return withSession(ctx, async (session) => {
        // Checked again at every batch: a code no longer bound to the PM is not read, and is
        // counted at the start of each round; none bound, the source is not authorized.
        const bound = await boundCodes(session, ctx, chosen)
        if (bound.size === 0) throw new ConnectorError('source_not_authorized')
        const units: Unit[] = chosen
          .filter((code) => bound.has(code))
          .flatMap((code) =>
            CATEGORIES.map((category) => ({ id: `${code}:${category}`, code, category })),
          )
        const ids = new Set(units.map((u) => u.id))
        let done = new Set((cursor?.done ?? []).filter((id) => ids.has(id)))
        // A round that ended starts again: a warehouse is read whole, project by project.
        if (done.size === units.length) done = new Set()
        const unbound = chosen.length - bound.size
        const skipped = done.size === 0 && unbound > 0 ? { code_not_bound: unbound } : undefined
        const pending = units.filter((u) => !done.has(u.id))
        const synced = await syncDates(session)
        const items: ExternalItem[] = []
        const extractions: SystemExtraction[] = []
        let rows = 0
        for (const unit of pending) {
          if (items.length >= limits.maxItems || (items.length > 0 && rows >= BATCH_ROWS)) break
          limits.signal.throwIfAborted()
          const read: ViewRows[] = []
          for (const view of DWSI_VIEWS.filter((v) => v.category === unit.category)) {
            read.push({
              view,
              rows: await readView(session, view, unit.code),
              sourceSyncedAt: view.syncEntity ? (synced.get(view.syncEntity) ?? null) : null,
            })
          }
          const externalId = `dwsi:${unit.code}:${unit.category}`
          // A view the warehouse should date and does not leaves the whole extraction undated:
          // its age is not deduced, never taken from the extraction (nor from the other views).
          const undated = read.some((r) => r.view.syncEntity !== null && r.sourceSyncedAt === null)
          const asOf = undated
            ? null
            : read.reduce((at, r) => older(at, r.sourceSyncedAt), extractedAt)
          items.push({
            externalId,
            version: extractedAt.toISOString(),
            title: extractionTitle(unit.category, unit.code, extractedAt),
            mediaType: 'text/markdown',
            bytes: extractionDocument(unit.category, unit.code, read),
            kind: CATEGORY_KIND[unit.category],
            originAt: asOf,
            author: null,
            url: null,
            perimeter: [prjOption(unit.code)],
            people: peopleOf(read),
          })
          for (const r of read) {
            extractions.push({
              evidenceExternalId: externalId,
              perimeter: prjOption(unit.code),
              view: r.view.name,
              rows: keyed(r.view, r.rows),
              extractedAt,
              sourceSyncedAt:
                r.sourceSyncedAt === null ? null : older(extractedAt, r.sourceSyncedAt),
            })
            rows += r.rows.length
          }
          done.add(unit.id)
        }
        const dataAsOf = items.some((item) => item.originAt === null)
          ? null
          : items.reduce((at, item) => older(at, item.originAt), extractedAt)
        return {
          items,
          extractions,
          nextCursor: { done: units.filter((u) => done.has(u.id)).map((u) => u.id) },
          done: units.every((u) => done.has(u.id)),
          dataAsOf,
          ...(skipped ? { skipped } : {}),
        }
      })
    },
  }
}

export const dwsiConnector = createDwsiConnector()
