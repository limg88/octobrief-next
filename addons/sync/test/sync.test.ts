import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ConnectorDelivery,
  ConnectorError,
  type ConnectorReader,
  parseSyncFile,
  readFolderBatch,
} from '@octobrief/connectors'
import type { Delivery, ExternalDocument, ExternalRecord } from '@octobrief/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAccess } from '../src/check.ts'
import {
  ConfigError,
  configuredSystems,
  EXAMPLE_CONFIG,
  parseConfig,
  readConfig,
  type SyncConfig,
  secretOf,
  sinceOf,
} from '../src/config.ts'
import { FeederError, type Provider } from '../src/feeder.ts'
import { resumeFrom, runPull, STATUS_FILE } from '../src/pull.ts'
import { runPush } from '../src/push.ts'
import { every, sleep } from '../src/schedule.ts'
import { parseSince } from '../src/since.ts'
import { MAX_TABLE_ROWS, recordBody, rowsBody } from '../src/sink/body.ts'
import { createFolderWriter, slug } from '../src/sink/folder-writer.ts'
import { emptySystem, openState } from '../src/sink/state.ts'
import { buildSources } from '../src/sources/build.ts'
import { claudeRunner, m365Prompt, m365Source, windowsOf } from '../src/sources/m365.ts'
import type { SystemSource } from '../src/sources/source.ts'
import { cursorFrom, jiraSite, trackerSource } from '../src/sources/tracker.ts'
import { fromDay, warehouseSource } from '../src/sources/warehouse.ts'
import { patWarning, renderStatus } from '../src/status.ts'
import { fromWire } from '../src/wire.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octobrief-addon-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  documents: [],
  records: [],
  rows: [],
  removed: [],
  dataAsOf: null,
  ...over,
})
const issue = (
  id: string,
  version = 'v1',
  fields: Record<string, unknown> = {},
): ExternalRecord => ({
  externalId: id,
  version,
  title: `Attività ${id}`,
  originAt: new Date('2026-11-10T09:00:00Z'),
  url: `https://jira.example.test/browse/BOR-${id}`,
  people: [{ displayName: 'Mario Rossi' }],
  record: { key: `BOR-${id}`, type: 'Bug', status: 'To Do', ...fields },
})
const mail = (id: string, over: Partial<ExternalDocument> = {}): ExternalDocument => ({
  externalId: id,
  version: 'v1',
  title: 'RE: Budget Borea è pronto?',
  mediaType: 'text/markdown',
  bytes: new TextEncoder().encode('Il budget resta di 890.000 euro.\n'),
  originAt: new Date('2026-11-10T09:00:00Z'),
  url: null,
  people: [],
  ...over,
})
const config = (over: Record<string, unknown> = {}): SyncConfig =>
  parseConfig({ folder: join(root, 'borea'), ...over })
const JIRA = { site: 'demo.atlassian.net', email: 'pm@example.test', tokenEnv: 'JIRA_TOKEN' }
const ADO = { organization: 'contoso', project: 'Borea', patEnv: 'ADO_PAT' }
const DWSI = {
  host: 'dwh.internal',
  database: 'dw',
  user: 'reader',
  passwordEnv: 'DWSI_PASSWORD',
  codes: ['PRJ000001'],
  owner: 'pm@example.test',
}
const realFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes('.octobrief-sync'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes('.octobrief-sync'))
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    // The hash of the id in a name is not what these tests are about.
    .map((name) => name.replace(/-[0-9a-f]{8}(\.\w+)$/, '-#$1'))
    .sort()

describe('start day', () => {
  it('reads a day in both forms as midnight in Italy', () => {
    expect(parseSince('2026-01-01')?.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(parseSince(' 01/07/2026 ')?.toISOString()).toBe('2026-06-30T22:00:00.000Z')
  })
  it.each(['', 'ieri', '2026-02-30', '31/04/2026', '2026/01/01'])('refuses «%s»', (text) => {
    expect(parseSince(text)).toBeNull()
  })
})

describe('configuration', () => {
  it('fills the defaults and names what it reads', () => {
    const parsed = config({ jira: JIRA, ado: ADO, dwsi: DWSI, m365: {} })
    expect(parsed.everyMinutes).toBe(30)
    expect(parsed.jira?.projects).toEqual([])
    expect(parsed.dwsi).toMatchObject({ port: 5432, tls: 'verify_full' })
    expect(parsed.m365).toMatchObject({ days: 7, claude: 'claude', keywords: [] })
    expect(configuredSystems(parsed)).toEqual(['jira', 'ado', 'dwsi', 'm365'])
    expect(configuredSystems(config())).toEqual([])
    // The example holds placeholders to replace: it names every block a PM may fill.
    expect(Object.keys(EXAMPLE_CONFIG)).toEqual(
      expect.arrayContaining(['folder', 'since', 'envFile', 'jira', 'ado', 'dwsi', 'm365']),
    )
  })

  it('names the keys that are wrong, never their values', () => {
    const wrong = () =>
      parseConfig({ folder: 'relativa', since: 'ieri', jira: { ...JIRA, tokenEnv: 'segreto-123' } })
    expect(wrong).toThrow(ConfigError)
    expect(wrong).toThrow(/folder, since, jira\.tokenEnv/)
    expect(wrong).not.toThrow(/segreto-123/)
    expect(() => parseConfig('x')).toThrow(/\(file\)/)
  })

  it('reads a file, and says when it cannot', () => {
    const path = join(root, 'config.json')
    writeFileSync(path, JSON.stringify({ folder: '/sync/borea' }))
    expect(readConfig(path).folder).toBe('/sync/borea')
    writeFileSync(path, 'non è JSON')
    expect(() => readConfig(path)).toThrow(/non si legge/)
    expect(() => readConfig(join(root, 'manca.json'))).toThrow(ConfigError)
  })

  it('takes a secret from the environment and names the variable that is missing', () => {
    expect(secretOf({ JIRA_TOKEN: ' abc ' }, 'JIRA_TOKEN')).toBe('abc')
    expect(() => secretOf({}, 'JIRA_TOKEN')).toThrow(/JIRA_TOKEN/)
  })

  it('reads each system from its own day, the common one, or the one given now', () => {
    const parsed = config({ since: '2026-01-01', jira: { ...JIRA, since: '2026-03-01' }, ado: ADO })
    expect(sinceOf(parsed, 'jira')?.toISOString()).toBe('2026-02-28T23:00:00.000Z')
    expect(sinceOf(parsed, 'ado')?.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(sinceOf(parsed, 'files')?.toISOString()).toBe('2025-12-31T23:00:00.000Z')
    expect(sinceOf(parsed, 'jira', '2026-06-01')?.toISOString()).toBe('2026-05-31T22:00:00.000Z')
    expect(sinceOf(config(), 'jira')).toBeNull()
  })
})

describe('folder writer', () => {
  it('writes records, documents and rows where Octobrief reads them back', async () => {
    const state = openState(root)
    const writer = createFolderWriter(root, state)
    const rows = {
      view: 'v_invoice_all',
      perimeter: 'PRJ000001',
      rows: [{ key: 'F-1', values: { amount: 100, note: 'a|b' } }],
      extractedAt: new Date('2026-11-12T08:00:00Z'),
      sourceSyncedAt: null,
    }
    expect(
      writer.write(
        'jira',
        delivery({ records: [issue('1')], dataAsOf: new Date('2026-11-12T08:00:00Z') }),
      ),
    ).toEqual({ written: 1, unchanged: 0, removed: 0 })
    writer.write('m365', delivery({ documents: [mail('m-1')] }), {
      via: 'claude',
      groupOf: () => 'mail',
    })
    writer.write('dwsi', delivery({ rows: [rows] }))
    state.save()
    expect(files(root)).toEqual([
      'jira/bor-1-#.md',
      'm365/mail/2026-11-10-re-budget-borea-e-pronto-#.md',
      'netsuite/v-invoice-all/prj000001.md',
    ])
    expect(parseSyncFile(readFileSync(realFiles(root)[1] as string, 'utf8'))).toMatchObject({
      system: 'm365',
      via: 'claude',
      type: 'document',
      externalId: 'm-1',
    })

    const jira = await readFolderBatch({
      dir: join(root, 'jira'),
      sync: { root, system: 'jira' },
      offset: 0,
    })
    expect(jira.records).toEqual([issue('1')])
    expect(jira.dataAsOf).toEqual(new Date('2026-11-12T08:00:00Z'))
    const warehouse = await readFolderBatch({
      dir: join(root, 'netsuite'),
      sync: { root, system: 'dwsi' },
      offset: 0,
    })
    expect(warehouse.rows).toEqual([rows])
  })

  it('writes a file again only when its version changes, and moves it when its name does', () => {
    const state = openState(root)
    const writer = createFolderWriter(root, state)
    writer.write('jira', delivery({ records: [issue('1')] }))
    expect(writer.write('jira', delivery({ records: [issue('1')] }))).toMatchObject({
      written: 0,
      unchanged: 1,
    })
    expect(writer.write('jira', delivery({ records: [issue('1', 'v2')] })).written).toBe(1)
    // The key changed at the source (the issue was moved): the old file goes.
    writer.write('jira', delivery({ records: [issue('1', 'v3', { key: 'APO-7' })] }))
    expect(files(root)).toEqual(['jira/apo-7-#.md'])
    // A file deleted by hand is written again.
    rmSync(realFiles(root)[0] as string)
    expect(
      writer.write('jira', delivery({ records: [issue('1', 'v3', { key: 'APO-7' })] })).written,
    ).toBe(1)
  })

  it('removes what is gone, tells Octobrief, and forgets the removal when the item is back', async () => {
    const state = openState(root)
    const writer = createFolderWriter(root, state)
    writer.write('m365', delivery({ documents: [mail('m-1'), mail('m-2')] }), {
      groupOf: (d) => (d.externalId === 'm-1' ? 'mail' : null),
    })
    expect(writer.write('m365', delivery({ removed: ['m-1', 'mai-visto'] })).removed).toBe(2)
    state.save()
    expect(files(root)).toEqual(['m365/2026-11-10-re-budget-borea-e-pronto-#.md'])
    expect(existsSync(join(root, 'm365/mail'))).toBe(false)
    expect(state.removedOf('m365')).toEqual(['m-1', 'mai-visto'])
    const read = await readFolderBatch({
      dir: join(root, 'm365'),
      sync: { root, system: 'm365' },
      offset: 0,
    })
    expect(read.removed).toEqual(['m-1', 'mai-visto'])

    writer.write('m365', delivery({ documents: [mail('m-1')] }))
    expect(state.removedOf('m365')).toEqual(['mai-visto'])
    // The state is read again from the folder by the next run.
    state.save()
    expect(openState(root).system('m365').items['m-1']?.version).toBe('v1')
    expect(openState(root).removedOf('jira')).toEqual([])
  })

  it('keeps a file that is not text as it is, and a text that is not Markdown with its type', () => {
    const state = openState(root)
    const writer = createFolderWriter(root, state)
    writer.write(
      'files',
      delivery({
        documents: [
          mail('pdf', { title: 'Contratto', mediaType: 'application/pdf', originAt: null }),
          mail('raw', { title: '???', mediaType: 'application/octet-stream', originAt: null }),
          mail('csv', {
            title: 'Export',
            mediaType: 'text/csv; charset=utf-8',
            systemKind: 'backlog_export',
          }),
        ],
      }),
    )
    const written = files(root)
    const paths = realFiles(root)
    expect(written).toEqual([
      'files/2026-11-10-export-#.md',
      'files/contratto-#.pdf',
      'files/elemento-#.bin',
    ])
    expect(parseSyncFile(readFileSync(paths[0] as string, 'utf8'))).toMatchObject({
      mediaType: 'text/csv',
      systemKind: 'backlog_export',
    })
  })

  it('makes names that are never a path', () => {
    expect(slug('../../Città & Co. — 100%')).toBe('citta-co-100')
    expect(slug('///')).toBe('elemento')
    expect(slug('a'.repeat(100)).length).toBe(60)
  })

  it('starts empty from a state that cannot be read', () => {
    const state = openState(root)
    state.save()
    writeFileSync(join(root, '.octobrief-sync/state.json'), '[non valido')
    writeFileSync(join(root, '.octobrief-sync/removed.json'), '"testo"')
    const again = openState(root)
    expect(again.system('jira')).toEqual(emptySystem())
    expect(again.all()).toEqual({ jira: emptySystem() })
  })
})

describe('readable text', () => {
  it('writes a tracker item as title, fields, description and comments', () => {
    const body = recordBody(
      issue('1', 'v1', {
        labels: ['ui', 'report'],
        sprint: null,
        nested: { a: 1 },
        points: 3,
        done: false,
        description: 'Il report non si apre.',
        comments: [
          { author: 'Mario Rossi', createdAt: '2026-11-10', body: 'Riprodotto.' },
          { text: 'Senza autore.' },
          'Solo testo',
          { author: 'Vuoto' },
          7,
        ],
      }),
    )
    expect(body).toBe(
      [
        '# BOR-1 — Attività 1',
        '',
        '- type: Bug',
        '- status: To Do',
        '- labels: ui, report',
        '- points: 3',
        '- done: false',
        '',
        '## Descrizione',
        '',
        'Il report non si apre.',
        '',
        '## Commenti',
        '',
        '- **Mario Rossi, 2026-11-10**: Riprodotto.',
        '- Senza autore.',
        '- Solo testo',
        '',
        'https://jira.example.test/browse/BOR-1',
        '',
      ].join('\n'),
    )
    const bare = recordBody({ ...issue('2'), url: null, record: { labels: [], comments: 'x' } })
    expect(bare).toBe('# Attività 2\n')
  })

  it('writes the rows of a view as a table, a long one in part', () => {
    const view = (count: number) => ({
      view: 'v_invoice_all',
      perimeter: 'PRJ1',
      rows: Array.from({ length: count }, (_, n) => ({
        key: `r${n}`,
        values: n === 0 ? { number: 'F|1', amount: 10 } : { number: `F-${n}`, paid: null },
      })),
      extractedAt: new Date(),
      sourceSyncedAt: null,
    })
    const small = rowsBody(view(2))
    expect(small).toContain('| number | amount | paid |')
    expect(small).toContain('| F\\|1 | 10 |  |')
    expect(small).not.toContain('Mostrate')
    const long = rowsBody(view(MAX_TABLE_ROWS + 5))
    expect(long).toContain(`Righe: ${MAX_TABLE_ROWS + 5}.`)
    expect(long).toContain(`Mostrate le prime ${MAX_TABLE_ROWS}`)
    expect(rowsBody(view(0))).toBe('# v_invoice_all — PRJ1\n\nRighe: 0.\n')
  })
})

/** A reader that gives the batches it was told to, and records how it was asked. */
function fakeReader(batches: ConnectorDelivery[] = [], accepts = 'token-ok') {
  const calls: Array<{
    what: string
    kind: string
    cursor?: unknown
    config?: unknown
    scope?: unknown
  }> = []
  const reader: ConnectorReader = {
    async connect(kind, rawConfig, secret, scope) {
      calls.push({ what: 'connect', kind, config: rawConfig, scope })
      if (secret !== accepts) throw new ConnectorError('source_auth_failed')
      return { config: { ...(rawConfig as object) }, perimeter: ['project:1'] }
    },
    async pull(source, cursor) {
      calls.push({ what: 'pull', kind: source.kind, cursor })
      const batch = batches.shift()
      if (!batch) throw new ConnectorError('source_unavailable')
      return batch
    },
  }
  return { reader, calls }
}
const batch = (over: Partial<Delivery>, nextCursor: unknown, done: boolean): ConnectorDelivery => ({
  ...delivery(over),
  nextCursor,
  done,
})
const tracker = (reader: ConnectorReader, secret = 'token-ok') =>
  trackerSource({ kind: 'jira', config: { site: 'demo' }, scope: ['BOR'], secret }, reader)
async function collect(source: SystemSource, cursor: unknown) {
  const out = []
  for await (const step of source.batches(cursor, new AbortController().signal)) out.push(step)
  return out
}

describe('sources', () => {
  it('reads a tracker batch after batch from the cursor', async () => {
    const { reader, calls } = fakeReader([
      batch({ records: [issue('1')] }, { updated: 'a', ids: ['1'] }, false),
      batch({ records: [issue('2')] }, { updated: 'b', ids: ['2'] }, true),
    ])
    const steps = await collect(tracker(reader), { updated: 'x', ids: ['0'] })
    expect(steps.map((s) => s.cursor)).toEqual([
      { updated: 'a', ids: ['1'] },
      { updated: 'b', ids: ['2'] },
    ])
    expect(calls.map((c) => [c.what, c.cursor])).toEqual([
      ['connect', undefined],
      ['pull', { updated: 'x', ids: ['0'] }],
      ['pull', { updated: 'a', ids: ['1'] }],
    ])
    await expect(collect(tracker(reader, 'sbagliato'), null)).rejects.toMatchObject({
      code: 'source_auth_failed',
    })
  })

  it('starts a tracker from a day with the cursor of its connector', () => {
    const day = new Date('2025-12-31T23:00:00Z')
    expect(cursorFrom('jira', day)).toEqual({ updated: '2025-12-31T23:00:00.000Z', ids: ['0'] })
    expect(cursorFrom('ado', day)).toEqual({ changedAt: '2025-12-31T23:00:00.000Z', id: 1 })
    expect(cursorFrom('jira', null)).toBeNull()
    expect(tracker(fakeReader().reader).startCursor(day)).toEqual(cursorFrom('jira', day))
  })

  it.each([
    ['contoso', 'contoso'],
    ['contoso.atlassian.net', 'contoso'],
    [' https://Contoso.Atlassian.net/jira/x ', 'Contoso'],
  ])('reads the Jira site from «%s»', (written, site) => {
    expect(jiraSite(written)).toBe(site)
  })

  it('reads timesheets from the start day and every other view whole', async () => {
    const view = (name: string) => ({
      view: name,
      perimeter: 'PRJ1',
      rows: [
        { key: 'a', values: { timesheetdate: '2025-12-15', invoicedate: '2025-12-15' } },
        { key: 'b', values: { timesheetdate: '2026-02-01', invoicedate: '2026-02-01' } },
        { key: 'c', values: { timesheetdate: null } },
      ],
      extractedAt: '2026-11-12T08:00:00Z',
    })
    const provider: Provider = {
      name: 'dwsi',
      async *deliveries() {
        yield { rows: [view('v_timesheet_all'), view('v_invoice_all')] }
      },
    }
    const source = warehouseSource(provider)
    const cursor = source.startCursor(new Date('2025-12-31T23:00:00Z'))
    const [step] = await collect(source, cursor)
    expect(step?.cursor).toEqual({ since: '2025-12-31T23:00:00.000Z' })
    expect(step?.delivery.rows.map((r) => r.rows.map((row) => row.key))).toEqual([
      ['b', 'c'],
      ['a', 'b', 'c'],
    ])
    expect(source.startCursor(null)).toBeNull()
    const [whole] = await collect(source, null)
    expect(whole?.delivery.rows[0]?.rows).toHaveLength(3)
    expect(fromDay(delivery(), null)).toEqual(delivery())
  })

  it('builds the sources a configuration names, with their secrets', () => {
    const { reader } = fakeReader()
    const env = { JIRA_TOKEN: 't', ADO_PAT: 'p', DWSI_PASSWORD: 'w' }
    const all = buildSources(config({ jira: JIRA, ado: ADO, dwsi: DWSI }), {
      env,
      reader,
      allowLoopback: true,
    })
    expect(all.map((s) => s.system)).toEqual(['jira', 'ado', 'dwsi'])
    expect(buildSources(config(), { env, reader })).toEqual([])
    expect(buildSources(config({ dwsi: DWSI }), { env, reader })).toHaveLength(1)
    expect(() => buildSources(config({ ado: ADO }), { env: {}, reader })).toThrow(/ADO_PAT/)
  })

  it('reads what a provider printed as a delivery', () => {
    const read = fromWire({
      dataAsOf: 'non una data',
      documents: [
        { externalId: 'a', version: '1', title: 'A', mediaType: 'text/plain', text: 'ciao' },
        {
          externalId: 'b',
          version: '1',
          title: 'B',
          mediaType: 'application/pdf',
          contentBase64: Buffer.from('pdf').toString('base64'),
          kind: 'contract',
          fileModifiedAt: '2026-11-01T00:00:00Z',
          originAt: '2026-11-02T00:00:00Z',
          url: 'https://x.example.test',
          people: [{ displayName: 'Paola Prova' }],
        },
        { externalId: 'c', version: '1', title: 'C', mediaType: 'application/pdf' },
      ],
      records: [{ externalId: 'r', version: '1', title: 'R', record: { a: 1 } }],
      rows: [{ view: 'v', perimeter: 'p', rows: [], extractedAt: 'x', sourceSyncedAt: null }],
      removed: ['z'],
    })
    expect(read.dataAsOf).toBeNull()
    expect(new TextDecoder().decode(read.documents[0]?.bytes)).toBe('ciao')
    expect(read.documents[1]).toMatchObject({
      systemKind: 'contract',
      fileModifiedAt: new Date('2026-11-01T00:00:00Z'),
      originAt: new Date('2026-11-02T00:00:00Z'),
      people: [{ displayName: 'Paola Prova' }],
    })
    expect(read.documents[2]?.bytes).toHaveLength(0)
    expect(read.records[0]).toMatchObject({ record: { a: 1 }, originAt: null, url: null })
    expect(read.rows[0]?.extractedAt).toEqual(new Date(0))
    expect(read.removed).toEqual(['z'])
    expect(fromWire({})).toEqual(delivery())
  })
})

const fixedSource = (
  system: SystemSource['system'],
  steps: Array<{ delivery: Delivery; cursor: unknown }>,
  failure?: Error,
): SystemSource & { asked: unknown[] } => {
  const asked: unknown[] = []
  return {
    system,
    asked,
    startCursor: (since) => (since ? { from: since.toISOString() } : null),
    async *batches(cursor) {
      asked.push(cursor)
      yield* steps
      if (failure) throw failure
    },
  }
}

describe('pull', () => {
  const NOW = new Date('2026-11-12T10:00:00Z')

  it('writes each system, saves where it stopped, and reports', async () => {
    const jira = fixedSource('jira', [
      { delivery: delivery({ records: [issue('1')] }), cursor: { n: 1 } },
      { delivery: delivery({ records: [issue('2')], removed: ['9'] }), cursor: { n: 2 } },
    ])
    const lines: string[] = []
    const cfg = config({ since: '2026-01-01', jira: JIRA })
    const outcomes = await runPull(cfg, [jira], { now: () => NOW, log: (l) => lines.push(l) })
    expect(outcomes).toEqual([
      { system: 'jira', written: 2, unchanged: 0, removed: 1, error: null },
    ])
    expect(lines).toEqual(['jira: 2 scritti, 0 invariati, 1 rimossi'])
    expect(jira.asked).toEqual([{ from: '2025-12-31T23:00:00.000Z' }])
    const saved = openState(cfg.folder).system('jira')
    expect(saved).toMatchObject({
      cursor: { n: 2 },
      since: '2025-12-31T23:00:00.000Z',
      dataAsOf: NOW.toISOString(),
      lastRunAt: NOW.toISOString(),
      lastError: null,
    })
    const status = readFileSync(join(cfg.folder, STATUS_FILE), 'utf8')
    expect(status).toContain('| Jira | jira/ | 2 | 2026-01-01 | 2026-11-12 10:00 UTC |')
    expect(status).toContain('| ok |')

    // The next run goes on from the saved cursor.
    const again = fixedSource('jira', [])
    await runPull(cfg, [again], { now: () => NOW })
    expect(again.asked).toEqual([{ n: 2 }])
  })

  it('keeps what a failing system wrote and goes on with the others', async () => {
    const jira = fixedSource(
      'jira',
      [{ delivery: delivery({ records: [issue('1')] }), cursor: { n: 1 } }],
      new ConnectorError('source_unreachable'),
    )
    const ado = fixedSource('ado', [], new FeederError('provider_failed', 'x'))
    const dwsi = fixedSource('dwsi', [], new Error('altro'))
    const m365 = fixedSource('m365', [
      {
        delivery: delivery({ documents: [mail('m')], dataAsOf: new Date('2026-11-11T08:00:00Z') }),
        cursor: null,
      },
    ])
    const lines: string[] = []
    const cfg = config({
      jira: JIRA,
      ado: { ...ADO, patExpiresOn: '2026-11-12' },
      dwsi: DWSI,
      m365: {},
    })
    const outcomes = await runPull(cfg, [jira, ado, dwsi, m365], {
      now: () => NOW,
      log: (l) => lines.push(l),
    })
    expect(outcomes.map((o) => [o.system, o.written, o.error])).toEqual([
      ['jira', 1, 'source_unreachable'],
      ['ado', 0, 'provider_failed: x'],
      ['dwsi', 0, 'sync_failed'],
      ['m365', 1, null],
    ])
    expect(lines.at(-1)).toMatch(/^ATTENZIONE: Il PAT di Azure DevOps è scaduto/)
    const state = openState(cfg.folder)
    expect(state.system('jira')).toMatchObject({
      cursor: { n: 1 },
      lastError: 'source_unreachable',
    })
    // The source said how fresh it is: its word is kept.
    expect(state.system('m365').dataAsOf).toBe('2026-11-11T08:00:00.000Z')
    const status = readFileSync(join(cfg.folder, STATUS_FILE), 'utf8')
    expect(status).toContain('non riuscita (source_unreachable)')
    expect(status).toContain('| inizio |')
    expect(status).toContain('**Attenzione**')
  })

  it('starts again from an earlier day, and only then', () => {
    const source = fixedSource('jira', [])
    const day = (text: string) => parseSince(text) as Date
    const known = {
      ...emptySystem(),
      cursor: { n: 5 },
      lastRunAt: 'x',
      since: day('2026-03-01').toISOString(),
    }
    expect(resumeFrom(known, source, day('2026-03-01'))).toEqual({ n: 5 })
    expect(resumeFrom(known, source, day('2026-06-01'))).toEqual({ n: 5 })
    expect(known.since).toBe(day('2026-03-01').toISOString())
    expect(resumeFrom(known, source, day('2026-01-01'))).toEqual({
      from: day('2026-01-01').toISOString(),
    })
    expect(known.since).toBe(day('2026-01-01').toISOString())
    // No day at all is earlier than any day.
    expect(resumeFrom(known, source, null)).toBeNull()
    expect(known.since).toBeNull()
    // Read from the beginning once: a day given later changes nothing.
    known.cursor = { n: 9 }
    expect(resumeFrom(known, source, day('2026-01-01'))).toEqual({ n: 9 })
    expect(known.since).toBeNull()
  })

  it('reports a system never run, and warns about the token only when it is time', () => {
    const cfg = config({ ado: { ...ADO, patExpiresOn: '2026-11-14' } })
    expect(renderStatus(cfg, {}, NOW)).toContain('| mai eseguita |')
    expect(patWarning(cfg, NOW)).toBeNull()
    expect(patWarning(cfg, new Date('2026-11-13T08:00:00Z'))).toMatch(/scade il 2026-11-14/)
    expect(patWarning(cfg, new Date('2026-11-14T08:00:00Z'))).toMatch(/è scaduto/)
    expect(patWarning(config({ ado: ADO }), NOW)).toBeNull()
    expect(patWarning(config(), NOW)).toBeNull()
  })
})

describe('push', () => {
  it('sends the subfolder of each system to its source, with its token', async () => {
    const cfg = config({
      push: {
        server: 'https://octobrief.example.test',
        sources: {
          jira: { id: '11111111-1111-4111-8111-111111111111', tokenEnv: 'OCTOBRIEF_TOKEN_JIRA' },
          m365: { id: '22222222-2222-4222-8222-222222222222', tokenEnv: 'OCTOBRIEF_TOKEN_M365' },
        },
      },
    })
    const state = openState(cfg.folder)
    createFolderWriter(cfg.folder, state).write('jira', delivery({ records: [issue('1')] }))
    state.save()
    const sent: Array<{ url: string; token: string | null; records: number }> = []
    const fetchFake = (async (url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      sent.push({
        url: String(url),
        token: new Headers(init.headers).get('authorization'),
        records: body.records?.length ?? 0,
      })
      return Response.json({
        created: 0,
        updated: 0,
        unchanged: 0,
        duplicates: 0,
        records: 1,
        rows: 0,
        removed: 0,
      })
    }) as unknown as typeof fetch
    const lines: string[] = []
    const results = await runPush(cfg, {
      env: { OCTOBRIEF_TOKEN_JIRA: 'obf_jira' },
      fetch: fetchFake,
      log: (l) => lines.push(l),
    })
    expect(sent).toEqual([
      {
        url: 'https://octobrief.example.test/api/ingest/11111111-1111-4111-8111-111111111111',
        token: 'Bearer obf_jira',
        records: 1,
      },
    ])
    expect(results.map((r) => [r.system, r.error === null])).toEqual([
      ['jira', true],
      ['m365', false],
    ])
    expect(lines[0]).toMatch(/^jira: 0 nuovi, .* 1 record/)
    expect(lines[1]).toMatch(/^m365: non inviata .*OCTOBRIEF_TOKEN_M365/)
    await expect(runPush(config(), { env: {} })).rejects.toThrow(/push/)
  })
})

describe('access check', () => {
  it('says what each tracker can read, or the code of the refusal', async () => {
    const { reader, calls } = fakeReader()
    const cfg = config({ jira: { ...JIRA, projects: ['BOR'] }, ado: ADO })
    expect(await checkAccess(cfg, { JIRA_TOKEN: 'token-ok', ADO_PAT: 'scaduto' }, reader)).toEqual([
      'Jira: accesso riuscito, 1 voci nel perimetro',
      'Azure DevOps: accesso NON riuscito (source_auth_failed)',
    ])
    expect(calls[0]).toMatchObject({
      config: { site: 'demo', email: 'pm@example.test' },
      scope: ['BOR'],
    })
    expect(calls[1]).toMatchObject({ config: { organization: 'contoso' }, scope: ['Borea'] })
    expect(await checkAccess(cfg, {}, reader)).toEqual([
      "Jira: accesso NON riuscito (manca la variabile d'ambiente JIRA_TOKEN)",
      "Azure DevOps: accesso NON riuscito (manca la variabile d'ambiente ADO_PAT)",
    ])
    expect(await checkAccess(config(), {}, reader)).toEqual([])
  })
})

describe('periodic run', () => {
  it('runs now and again after each wait, until stopped; a failed run does not stop it', async () => {
    const stop = new AbortController()
    const waits: number[] = []
    const errors: unknown[] = []
    let runs = 0
    const done = await every(
      15,
      async () => {
        runs++
        if (runs === 2) throw new Error('rete')
      },
      {
        signal: stop.signal,
        onError: (error) => errors.push(error),
        wait: async (ms) => {
          waits.push(ms)
          if (waits.length === 3) stop.abort()
        },
      },
    )
    expect(done).toBe(3)
    expect(waits).toEqual([900_000, 900_000, 900_000])
    expect(errors).toHaveLength(1)
  })

  it('waits, and stops waiting when asked', async () => {
    const stop = new AbortController()
    const started = Date.now()
    setTimeout(() => stop.abort(), 5)
    await sleep(60_000, stop.signal)
    await sleep(60_000, stop.signal)
    await sleep(1, new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('Microsoft 365 through Claude', () => {
  const m365 = (over: Record<string, unknown> = {}) =>
    config({ m365: over }).m365 as NonNullable<SyncConfig['m365']>
  const week = { from: new Date('2026-01-05T23:00:00Z'), to: new Date('2026-01-12T23:00:00Z') }
  const answer = (ids: string[], truncated = false) =>
    JSON.stringify({
      truncated,
      documents: ids.map((id) => ({
        externalId: id,
        version: 'v1',
        title: `Elemento ${id}`,
        mediaType: 'text/markdown',
        text: `Testo di ${id}.`,
        originAt: '2026-01-07T10:00:00Z',
      })),
    })

  it('covers a period with weekly windows, the last one shorter', () => {
    const windows = windowsOf(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-17T12:00:00Z'))
    expect(
      windows.map((w) => [w.from.toISOString().slice(0, 10), w.to.toISOString().slice(0, 16)]),
    ).toEqual([
      ['2026-01-01', '2026-01-08T00:00'],
      ['2026-01-08', '2026-01-15T00:00'],
      ['2026-01-15', '2026-01-17T12:00'],
    ])
    expect(windowsOf(week.to, week.from)).toEqual([])
  })

  it('asks each section only for what the perimeter names, read-only, within the window', () => {
    const cfg = m365({
      keywords: ['Borea', 'carla@cliente.example'],
      outlook: { folders: ['Progetti/Borea'], mailboxes: ['pmo@example.test'] },
      teams: { channels: ['Borea/Generale'], chats: ['Borea core'] },
      sharepoint: { paths: ['https://contoso.sharepoint.com/sites/Borea/Documenti'] },
    })
    const mailPrompt = m365Prompt('mail', cfg, week) as string
    expect(mailPrompt).toContain('SOLO strumenti di lettura')
    expect(mailPrompt).toContain('dal 2026-01-06 (compreso) al 2026-01-13 (escluso)')
    expect(mailPrompt).toContain('nelle cartelle di Outlook «Progetti/Borea»')
    expect(mailPrompt).toContain('nelle caselle condivise o delegate «pmo@example.test»')
    expect(mailPrompt).toContain('«Borea», «carla@cliente.example»')
    expect(mailPrompt).not.toContain('"kind"')
    const teamsPrompt = m365Prompt('teams', cfg, week) as string
    expect(teamsPrompt).toContain('nei canali «Borea/Generale» e nelle chat «Borea core»')
    expect(teamsPrompt).toContain('"kind":"transcript')
    expect(m365Prompt('file', cfg, week)).toContain(
      'sotto i percorsi «https://contoso.sharepoint.com/sites/Borea/Documenti»',
    )

    // Nothing named for a section, and no keyword: the section is not asked.
    const onlyChannels = m365({ teams: { channels: ['Borea/Generale'] } })
    expect(m365Prompt('mail', onlyChannels, week)).toBeNull()
    expect(m365Prompt('file', onlyChannels, week)).toBeNull()
    expect(m365Prompt('teams', onlyChannels, week)).not.toContain('oppure')
    expect(m365Prompt('file', m365({ keywords: ['Borea'] }), week)).toContain('che contengono')
  })

  it('reads from the start day window by window, and moves the cursor when a window is whole', async () => {
    const prompts: string[] = []
    const run = async (prompt: string) => {
      prompts.push(prompt)
      const id = `${prompt.includes('mail di Outlook') ? 'mail' : 'teams'}-${prompts.length}`
      // Claude wraps its answer in a result, with some prose around it.
      return JSON.stringify({ type: 'result', result: `Ecco: ${answer([id])}` })
    }
    const now = () => new Date('2026-01-15T23:00:00Z')
    const source = m365Source(
      m365({ keywords: ['Borea'], teams: { channels: ['Borea/Generale'] } }),
      run,
      now,
    )
    const start = source.startCursor(new Date('2025-12-31T23:00:00Z'))
    expect(start).toEqual({ until: '2025-12-31T23:00:00.000Z' })
    const steps = await collect(source, start)
    // Three windows (the overlap day, two weeks and a rest) by three sections.
    expect(prompts).toHaveLength(9)
    expect(steps.map((s) => (s.cursor as { until: string }).until.slice(0, 10))).toEqual([
      '2025-12-31',
      '2025-12-31',
      '2025-12-31',
      '2026-01-06',
      '2026-01-06',
      '2026-01-06',
      '2026-01-06',
      '2026-01-13',
      '2026-01-13',
      '2026-01-13',
      '2026-01-13',
      '2026-01-15',
    ])
    expect(steps[0]?.writer?.groupOf?.(steps[0].delivery.documents[0] as ExternalDocument)).toBe(
      'mail',
    )
    expect(steps[1]?.writer?.groupOf?.(steps[1].delivery.documents[0] as ExternalDocument)).toBe(
      'riunioni',
    )
    expect(steps[2]?.writer).toMatchObject({ via: 'claude' })
    expect(steps[3]?.delivery.dataAsOf).toEqual(new Date('2026-01-06T23:00:00Z'))
    expect(source.writer).toEqual({ via: 'claude' })
  })

  it('without a start day reads the last days; later runs read again the last day only', async () => {
    const asked: string[] = []
    const run = async (prompt: string) => {
      asked.push(
        prompt
          .match(/dal (\S+) \(compreso\) al (\S+)/)
          ?.slice(1)
          .join('→') ?? '',
      )
      return answer([])
    }
    const now = () => new Date('2026-01-15T10:00:00Z')
    const source = m365Source(m365({ keywords: ['Borea'], days: 3 }), run, now)
    expect(source.startCursor(null)).toBeNull()
    const first = await collect(source, null)
    expect(asked[0]).toBe('2026-01-12→2026-01-15')
    expect(first.at(-1)?.cursor).toEqual({ until: '2026-01-15T10:00:00.000Z' })
    asked.length = 0
    await collect(source, first.at(-1)?.cursor)
    expect(asked[0]).toBe('2026-01-14→2026-01-15')
  })

  it('splits a window that holds more than an answer carries, down to a day', async () => {
    const asked: string[] = []
    const run = async (prompt: string) => {
      const [from, to] = prompt.match(/dal (\S+) \(compreso\) al (\S+)/)?.slice(1) ?? []
      asked.push(`${from}→${to}`)
      const days = (Date.parse(to as string) - Date.parse(from as string)) / 86_400_000
      return answer([`${from}`], days > 2)
    }
    const source = m365Source(m365({ outlook: { folders: ['Borea'] } }), run, () => week.to)
    const steps = await collect(source, {
      until: new Date(week.from.getTime() + 86_400_000).toISOString(),
    })
    expect(asked).toEqual([
      '2026-01-06→2026-01-13',
      '2026-01-06→2026-01-10',
      '2026-01-06→2026-01-08',
      '2026-01-08→2026-01-10',
      '2026-01-10→2026-01-13',
      '2026-01-10→2026-01-12',
      '2026-01-12→2026-01-13',
    ])
    expect(steps.flatMap((s) => s.delivery.documents.map((d) => d.externalId))).toEqual([
      '2026-01-06',
      '2026-01-08',
      '2026-01-10',
      '2026-01-12',
    ])
  })

  it('fails as a provider when Claude prints no delivery, or cannot be run', async () => {
    const source = m365Source(
      m365({ keywords: ['Borea'] }),
      async () => 'Non posso.',
      () => week.to,
    )
    await expect(collect(source, { until: week.from.toISOString() })).rejects.toMatchObject({
      code: 'provider_failed',
    })
    const missing = claudeRunner(m365({ claude: join(root, 'claude-che-non-esiste') }))
    await expect(missing('x')).rejects.toMatchObject({ code: 'provider_failed' })
    const script = join(root, 'claude-finto.sh')
    writeFileSync(script, '#!/bin/sh\necho "$@"\n', { mode: 0o755 })
    const printed = await claudeRunner(m365({ claude: script, allowedTools: ['a', 'b'] }))('ciao')
    expect(printed.trim()).toBe('-p ciao --output-format json --allowedTools a,b')
  })

  it('is built from the configuration with the runner given', async () => {
    const { reader } = fakeReader()
    const [source] = buildSources(config({ m365: { keywords: ['Borea'], days: 1 } }), {
      env: {},
      reader,
      claude: async () => answer(['a']),
    })
    expect(source?.system).toBe('m365')
    expect(buildSources(config({ m365: {} }), { env: {}, reader })).toHaveLength(1)
  })
})
