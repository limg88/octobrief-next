import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { SESSIONS_OF_DATABASE, waitForNoSessions, withDatabase } from './database.ts'

const ENV_FILE = fileURLToPath(new URL('../../../../.env.local', import.meta.url))

function ownerUrl(): string {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
  const url = process.env.DATABASE_OWNER_URL
  if (!url) throw new Error('The fake DWSI needs DATABASE_OWNER_URL: run `pnpm db:setup` once')
  return url
}

async function asOwner(url: string, statements: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(statements)
  } finally {
    await client.end()
  }
}

/** Waits (bounded) until the sessions the connector closed have really left the database. */
async function noSessionsLeft(url: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await waitForNoSessions(async () => {
      const { rows } = await client.query(SESSIONS_OF_DATABASE, [database])
      return rows[0].n
    })
  } finally {
    await client.end()
  }
}

/**
 * The relations of the fake warehouse: base tables with more columns than the extractor reads
 * (personal notes, sales representatives, comments), and the views over them, in the shapes and
 * types of the real DWSI views (as its schema probe found them on 09/11/2026: work and order
 * amounts in floating point, the closing of an order line as text, the period of the monthly
 * revenue in floating point).
 */
const SCHEMA = `
CREATE SCHEMA dwsi;
CREATE TABLE dwsi.base_timesheet (
  internalid int8 PRIMARY KEY, subsidiary varchar(50), employee varchar(100), timesheetdate date,
  projectid varchar(9), casetaskevent varchar(512), memo varchar(2048), smartworking varchar(5),
  reperibilita varchar(3), tipoore varchar(2), duration numeric(18, 4), approvalstatus varchar(50),
  laborcosthh_new numeric(18, 4), laborcost_new numeric(18, 4)
);
CREATE VIEW dwsi.v_timesheet_all AS SELECT * FROM dwsi.base_timesheet;
CREATE TABLE dwsi.base_project (
  projectid varchar(9) PRIMARY KEY, "name" varchar(512), projectmanager varchar(100),
  customername varchar(512), status varchar(50), startdate date, calculatedenddate date,
  enddate date, plannedwork float8, actualwork float8, remainingwork float8, percentcomplete float8,
  salesrep varchar(100)
);
CREATE VIEW dwsi.v_project AS SELECT * FROM dwsi.base_project;
CREATE TABLE dwsi.base_sales_order (
  salesorderid varchar(30), lineid int4, salesorderdate date, status varchar(50), item varchar(255),
  quantity float8, amount float8, invoiced float8, projectid varchar(9), closed varchar(5),
  salesrep varchar(100)
);
CREATE VIEW dwsi.v_sales_order_all AS SELECT * FROM dwsi.base_sales_order;
CREATE TABLE dwsi.base_invoice (
  invoiceid varchar(30), lineid int4, status varchar(50), invoicedate date, item varchar(255),
  amount numeric(18, 4), annocompetenza int4, projectid varchar(9), salesorder varchar(30),
  "type" varchar(30), memo varchar(2048)
);
CREATE VIEW dwsi.v_invoice_all AS SELECT * FROM dwsi.base_invoice;
CREATE TABLE dwsi.base_project_revenue (
  projectid varchar(9), anno float8, mese float8, itemgroup varchar(50), "cost" numeric(18, 4),
  actualcost numeric(18, 4), revenue numeric(18, 4), actualrevenue numeric(18, 4),
  internalid int8, cost_new numeric(18, 4)
);
CREATE VIEW dwsi.v_project_revenue_all AS SELECT * FROM dwsi.base_project_revenue;
CREATE TABLE dwsi.base_pl (
  projectid varchar(9), anno int4, mese int4, revenue numeric(18, 4), cost_labor_ts numeric(18, 4),
  cost_total numeric(18, 4)
);
CREATE VIEW dwsi.v_database_pl_all AS SELECT * FROM dwsi.base_pl;
CREATE TABLE dwsi.base_backlog (
  projectid varchar(9), backlogrefperiod date, amount numeric(18, 4), amountbilled numeric(18, 4),
  amountrecognized numeric(18, 4), salesrep varchar(100)
);
CREATE VIEW dwsi.v_backlog_all AS SELECT * FROM dwsi.base_backlog;
CREATE TABLE dwsi.dw_prod_projectpercentcomplete (
  projectid varchar(9) NOT NULL, "period" varchar(255) NOT NULL, perioddate date,
  percentcomplete float8, periodstatus varchar(255), "comments" varchar(512),
  internalid int8 NOT NULL
);
CREATE TABLE dwsi.dw_prod_syncdata (entity varchar(30) PRIMARY KEY, datelastsync timestamp);
CREATE TABLE dwsi.base_employee (
  internalid int8 PRIMARY KEY, "name" varchar(100), email varchar(254), altemail varchar(254),
  birthdate date, phone varchar(50), laborcost numeric(18, 4), jobtitle varchar(100)
);
CREATE VIEW dwsi.v_dw_employee AS SELECT * FROM dwsi.base_employee;
`

const RELATIONS = [
  'v_timesheet_all',
  'v_project',
  'v_sales_order_all',
  'v_invoice_all',
  'v_project_revenue_all',
  'v_database_pl_all',
  'v_backlog_all',
  'dw_prod_projectpercentcomplete',
  'dw_prod_syncdata',
  'v_dw_employee',
]

/**
 * Synthetic data of two projects: Apollo (PRJ000101, managed by Marta Neri) and Borea
 * (PRJ000202, managed by Luca Bassi, where Marta Neri also wrote hours), and their employees
 * with their emails (and HR columns never read).
 */
const SEED = `
INSERT INTO dwsi.base_project VALUES
  ('PRJ000101', 'Apollo', 'Marta Neri', 'Cliente Uno', 'In corso', '2026-01-12', '2026-12-18',
   NULL, 1200.0000, 640.5000, 559.5000, 53.3750, 'Rino Venditti'),
  ('PRJ000202', 'Borea', 'Luca Bassi', 'Cliente Due', 'In corso', '2026-03-02', NULL, NULL,
   300.0000, 10.0000, 290.0000, 3.3300, 'Rino Venditti');
INSERT INTO dwsi.base_timesheet VALUES
  (9001, 'IT', 'Anna Riva', '2026-10-05', 'PRJ000101', 'Analisi', 'nota privata', 'si', 'no',
   'OR', 7.5000, 'Approved', 41.2000, 309.0000),
  (9002, 'IT', 'Bruno Sala', '2026-10-06', 'PRJ000101', '=SUM(A1)|x', NULL, NULL, NULL, 'OR',
   8.0000, 'Pending Approval', 38.0000, 304.0000),
  (9003, 'IT', 'Carla Fumi', '2026-10-06', 'PRJ000202', 'Sviluppo', NULL, NULL, NULL, 'OR',
   4.0000, 'Approved', 40.0000, 160.0000),
  (9004, 'IT', 'Marta Neri', '2026-10-07', 'PRJ000202', 'Supporto', NULL, NULL, NULL, 'OR',
   1.0000, 'Approved', 45.0000, 45.0000);
INSERT INTO dwsi.base_employee VALUES
  (1, 'Marta Neri', 'Marta.Neri@example.test', NULL, '1980-01-01', '+39 000', 45.0000, 'PM'),
  (2, 'Luca Bassi', 'luca.bassi@example.test', NULL, '1981-02-02', '+39 001', 44.0000, 'PM'),
  (3, 'Anna Riva', 'anna.riva@example.test', NULL, '1990-03-03', '+39 002', 41.2000, 'Dev'),
  (4, 'Carla Fumi', 'carla.fumi@example.test', NULL, '1991-04-04', '+39 003', 40.0000, 'Dev'),
  (5, 'Ugo Esterno', 'ugo@example.test', NULL, NULL, NULL, NULL, 'Altro');
INSERT INTO dwsi.base_sales_order VALUES
  ('SO-17', 1, '2026-01-10', 'Billed', 'Servizi', 1.0000, 98000.0000, 45000.0000, 'PRJ000101',
   'F', 'Rino Venditti');
INSERT INTO dwsi.base_invoice VALUES
  ('INV-5', 1, 'Paid', '2026-06-30', 'Servizi', 45000.0000, 2026, 'PRJ000101', 'SO-17', 'Invoice',
   'memo interno');
INSERT INTO dwsi.base_project_revenue VALUES
  ('PRJ000101', 2026, 9, 'Labor', 10000.0000, 9500.0000, 14000.0000, 13800.0000, 77, 1.0000),
  ('PRJ000101', 2026, 9, 'Labor', 200.0000, 200.0000, 0.0000, 0.0000, 78, 1.0000);
INSERT INTO dwsi.base_pl VALUES ('PRJ000101', 2026, 9, 14000.0000, 9500.0000, 10200.0000);
INSERT INTO dwsi.base_backlog VALUES
  ('PRJ000101', '2026-10-01', 53000.0000, 45000.0000, 41000.0000, 'Rino Venditti');
INSERT INTO dwsi.dw_prod_projectpercentcomplete VALUES
  ('PRJ000101', 'Ott 2026', '2026-10-31', 0.53, 'Open', 'commento', 1);
INSERT INTO dwsi.dw_prod_syncdata VALUES
  ('TIMESHEET', '2026-11-05 06:00:00'), ('PROJECT', '2026-11-05 06:10:00.250'),
  ('SALESORDER', '2026-11-04 22:00:00'), ('INVOICE', '2026-11-04 22:05:00'),
  ('PROJECTREVENUE', '2026-11-04 23:00:00'), ('BACKLOG', '2026-11-04 23:30:00'),
  ('PROJECTPERCENTCOMPLETE', '2026-11-05 05:00:00'), ('EMPLOYEE', '2026-11-05 05:00:00');
`

export interface DwsiAccount {
  user: string
  password: string
}

/**
 * A fake DWSI: a database of its own on the test Postgres with the `dwsi` schema, its views and
 * synthetic data, an unprivileged read-only account for the connector and, for the refusals, an
 * account with a write privilege. Its owner changes data and definitions.
 */
export interface FakeDwsi {
  host: string
  port: number
  database: string
  reader: DwsiAccount
  /** Reads like the reader, and may also insert into one view. */
  writer: DwsiAccount
  /** Reads like the reader, and may also update one column of a view. */
  columnWriter: DwsiAccount
  /** Reads like the reader, and owns one of the views (an owner can change it). */
  viewOwner: DwsiAccount
  /** A superuser. */
  superuser: DwsiAccount
  /** Reads like the reader, and is a member (without inheriting) of the writer. */
  writerMember: DwsiAccount
  /** Reads like the reader, and may create roles. */
  roleCreator: DwsiAccount
  /** Runs statements as the owner of the warehouse. */
  exec(statements: string): Promise<void>
  drop(): Promise<void>
}

export async function startFakeDwsi(): Promise<FakeDwsi> {
  const owner = ownerUrl()
  const tag = randomBytes(6).toString('hex')
  const database = `dwsi_fake_${tag}`
  const account = (role: string): DwsiAccount => ({
    user: `dwsi_${role}_${tag}`,
    password: randomBytes(18).toString('hex'),
  })
  const reader = account('reader')
  const writer = account('writer')
  const columnWriter = account('colwriter')
  const viewOwner = account('owner')
  const superuser = account('super')
  const writerMember = account('member')
  const roleCreator = account('creator')
  const accounts = [reader, writer, columnWriter, viewOwner, superuser, writerMember, roleCreator]
  const roles = accounts.map((a) => a.user).join(', ')
  const create = accounts
    .map(
      (a) =>
        `CREATE ROLE ${a.user} LOGIN ${a === superuser ? 'SUPERUSER' : 'NOSUPERUSER'} ` +
        `${a === roleCreator ? 'CREATEROLE ' : ''}NOINHERIT PASSWORD '${a.password}';`,
    )
    .join('\n')
  await asOwner(owner, `CREATE DATABASE ${database}`)
  const url = withDatabase(owner, database)
  const grants = RELATIONS.map((r) => `dwsi.${r}`).join(', ')
  await asOwner(
    url,
    `${SCHEMA}${SEED}
     ${create}
     GRANT CONNECT ON DATABASE ${database} TO ${roles};
     GRANT USAGE ON SCHEMA dwsi TO ${roles};
     GRANT SELECT ON ${grants} TO ${roles};
     GRANT INSERT ON dwsi.v_invoice_all TO ${writer.user};
     GRANT UPDATE (status) ON dwsi.v_project TO ${columnWriter.user};
     GRANT CREATE ON SCHEMA dwsi TO ${viewOwner.user};
     GRANT SELECT ON dwsi.base_backlog TO ${viewOwner.user};
     ALTER VIEW dwsi.v_backlog_all OWNER TO ${viewOwner.user};
     GRANT ${writer.user} TO ${writerMember.user};`,
  )
  const parsed = new URL(owner)
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database,
    reader,
    writer,
    columnWriter,
    viewOwner,
    superuser,
    writerMember,
    roleCreator,
    exec: (statements) => asOwner(url, statements),
    async drop() {
      // A session closes after its close() resolves: the forced drop then ends only stragglers.
      await noSessionsLeft(owner, database)
      await asOwner(owner, `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      await asOwner(owner, accounts.map((a) => `DROP ROLE IF EXISTS ${a.user};`).join('\n'))
    },
  }
}
