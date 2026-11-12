import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BlockedCall,
  type ConnectorContext,
  ConnectorError,
  createJiraConnector,
  createNetGuard,
  createSafeHttp,
  type ExternalItem,
  type JiraConfig,
  type JiraCursor,
  type SyncBatch,
} from '../src/index.ts'
import { SecretValue } from '../src/secret-value.ts'
import {
  type FakeIssue,
  type FakeJira,
  type FakeJiraOptions,
  type FakeProject,
  jiraComment,
  jiraIssue,
  startFakeJira,
} from './support/fake-jira.ts'
import { assertRulesConfined, HOSTILE_VALUES } from './support/rules-contract.ts'

const APOLLO: FakeProject = { id: '10000', key: 'APO', name: 'Apollo Ünità' }
const BOREA: FakeProject = { id: '10001', key: 'BOR', name: 'Borea' }
const EMAIL = 'octobrief@example.test'
/** The worker's clock in these tests. */
const NOW = new Date('2026-11-05T09:30:00.000Z')
const CLOUD_ID = '8c2f1e6b-3a4d-4e5f-9a0b-1c2d3e4f5a6b'
/** Every name of a time field of Jira: none is ever asked, read or kept. */
const TIME_FIELDS = [
  'worklog',
  'timetracking',
  'timespent',
  'timeoriginalestimate',
  'timeestimate',
  'aggregatetimespent',
  'aggregatetimeoriginalestimate',
  'aggregatetimeestimate',
  'aggregateprogress',
]

const fakes: FakeJira[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.server.close()))
})

interface Setup {
  fake: FakeJira
  config: JiraConfig
  blocked: BlockedCall[]
  connector: ReturnType<typeof createJiraConnector>
  ctx(
    perimeter: string[],
    overrides?: Partial<ConnectorContext<JiraConfig>>,
  ): ConnectorContext<JiraConfig>
}

async function setup(issues: FakeIssue[], extra: Partial<FakeJiraOptions> = {}): Promise<Setup> {
  const token = randomBytes(18).toString('base64url')
  const options: FakeJiraOptions = {
    email: EMAIL,
    token,
    projects: [APOLLO, BOREA],
    issues,
    ...extra,
  }
  const fake = await startFakeJira(options)
  fakes.push(fake)
  // Jira's clock is the worker's unless a test moves it.
  fake.now = NOW
  const connector = createJiraConnector({
    endpoint: () => ({
      origin: fake.server.origin,
      host: fake.server.host,
      prefix: [],
      browse: 'https://contoso.atlassian.net',
    }),
  })
  const config = connector.parseConfig({
    site: 'contoso',
    cloudId: null,
    email: EMAIL,
    storyPointsField: 'customfield_10016',
    sprintField: 'customfield_10020',
    readOnlyToken: true,
  })
  const blocked: BlockedCall[] = []
  return {
    fake,
    config,
    blocked,
    connector,
    ctx: (perimeter, overrides = {}) => {
      const cfg = overrides.config ?? config
      return {
        config: cfg,
        perimeter,
        secret: new SecretValue(token),
        http: createSafeHttp({
          rules: connector.rules(cfg),
          onBlocked: async (call) => {
            blocked.push(call)
          },
          allowLoopbackHttp: true,
          sleep: async () => undefined,
        }),
        net: createNetGuard({ privateHosts: [], onBlocked: async () => undefined }),
        signal: new AbortController().signal,
        now: () => NOW,
        ...overrides,
      }
    },
  }
}

const records = (b: SyncBatch<JiraCursor>) => b.items.filter((i) => i.record !== undefined)
const exportOf = (b: SyncBatch<JiraCursor>) => b.items.find((i) => i.bytes !== undefined)
const limits = (maxItems: number) => ({ maxItems, signal: new AbortController().signal })
const searches = (s: Setup) =>
  s.fake.server.received.filter((r) => r.url.startsWith('/rest/api/3/search/jql'))
const APO = [`project:${APOLLO.id}`]

async function syncAll(s: Setup, perimeter: string[], maxItems: number, from: JiraCursor = null) {
  const batches: SyncBatch<JiraCursor>[] = []
  let cursor = from
  for (let i = 0; i < 50; i += 1) {
    const batch = await s.connector.sync(s.ctx(perimeter), cursor, limits(maxItems))
    batches.push(batch)
    cursor = batch.nextCursor
    if (batch.done) return { batches, cursor }
  }
  throw new Error('the sync never ended')
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

const at = (minute: number, second = 0, ms = 0) =>
  new Date(Date.UTC(2026, 10, 1, 10, minute, second, ms)).toISOString()

describe('the Jira configuration', () => {
  const connector = createJiraConnector()
  const valid = {
    site: 'contoso',
    cloudId: null,
    email: EMAIL,
    storyPointsField: 'customfield_10016',
    sprintField: null,
    readOnlyToken: true,
  }

  it('needs a site, the account email and the PM declaring the token read-only', () => {
    expect(connector.parseConfig(valid)).toEqual(valid)
    expect(connector.parseConfig({ ...valid, site: 'Contoso' }).site).toBe('contoso')
    expect(connector.parseConfig({ ...valid, cloudId: CLOUD_ID.toUpperCase() }).cloudId).toBe(
      CLOUD_ID,
    )
    for (const raw of [
      { ...valid, readOnlyToken: false },
      { ...valid, readOnlyToken: undefined },
      { ...valid, site: 'contoso.atlassian.net' },
      { ...valid, site: 'evil.com/x' },
      { ...valid, site: '-contoso' },
      { ...valid, site: 'contosò' },
      { ...valid, email: 'not an email' },
      { ...valid, email: 'a:b@example.test' },
      { ...valid, storyPointsField: 'worklog' },
      { ...valid, storyPointsField: 'customfield_1,worklog' },
      { ...valid, sprintField: '*all' },
      { ...valid, cloudId: 'contoso' },
      null,
      [],
    ]) {
      expect(() => connector.parseConfig(raw), JSON.stringify(raw)).toThrow(ConnectorError)
    }
  })

  it('reaches <site>.atlassian.net, or the API gateway for the site’s cloud id, nothing else', () => {
    const site = connector.rules(connector.parseConfig(valid))
    expect(new Set(site.map((r) => r.host))).toEqual(new Set(['contoso.atlassian.net']))
    const gateway = connector.rules(connector.parseConfig({ ...valid, cloudId: CLOUD_ID }))
    expect(new Set(gateway.map((r) => r.host))).toEqual(new Set(['api.atlassian.com']))
    expect(
      gateway.every(
        (r) =>
          (r.path.slice(0, 3) as { literal: string }[]).map((p) => p.literal).join('/') ===
          `ex/jira/${CLOUD_ID}`,
      ),
    ).toBe(true)
  })

  it('reads only: GET on the account, the projects, the search and the comments of an issue', () => {
    const shown = connector
      .rules(connector.parseConfig(valid))
      .map((r) => `${r.method} ${r.path.map((p) => (p === 'segment' ? '*' : p.literal)).join('/')}`)
    expect(shown.sort()).toEqual(
      [
        'GET rest/api/3/myself',
        'GET rest/api/3/project/search',
        'GET rest/api/3/search/jql',
        'GET rest/api/3/issue/*/comment',
      ].sort(),
    )
  })

  it('keeps every configuration value confined (the connectors contract)', () => {
    const cfg = (over: Partial<JiraConfig>): JiraConfig => ({
      site: 'contoso',
      cloudId: null,
      email: EMAIL,
      storyPointsField: null,
      sprintField: null,
      readOnlyToken: true,
      ...over,
    })
    assertRulesConfined(connector.rules, (site) => cfg({ site }))
    assertRulesConfined(connector.rules, (site) => cfg({ site, cloudId: CLOUD_ID }))
    assertRulesConfined(connector.rules, (email) => cfg({ email }))
    assertRulesConfined(connector.rules, (storyPointsField) => cfg({ storyPointsField }))
    assertRulesConfined(connector.rules, (sprintField) => cfg({ sprintField }))
    for (const value of HOSTILE_VALUES) {
      expect(() => connector.rules(cfg({ cloudId: value })), JSON.stringify(value)).toThrow(
        ConnectorError,
      )
    }
  })

  it('refuses an unreadable cursor', () => {
    expect(connector.parseCursor(null)).toBeNull()
    const cursor = { updated: '2026-11-01T10:00:00.000Z', ids: ['10001', '10002'] }
    expect(connector.parseCursor(cursor)).toEqual(cursor)
    for (const raw of [
      { updated: 'ieri', ids: ['1'] },
      { updated: '2026-11-01T10:00:00.000Z', ids: [] },
      { updated: '2026-11-01T10:00:00.000Z', ids: ['APO-1'] },
      { updated: '2026-11-01T10:00:00.000Z', ids: Array.from({ length: 1001 }, (_, i) => `${i}`) },
      { ids: ['1'] },
      'x',
    ]) {
      expect(() => connector.parseCursor(raw), JSON.stringify(raw).slice(0, 80)).toThrow()
    }
  })
})

describe('the connection test', () => {
  it('answers ok with a token Jira takes, as Basic email:token in the header only', async () => {
    const s = await setup([])
    expect(await s.connector.test(s.ctx([]))).toEqual({ ok: true })
    const [request] = s.fake.server.received
    expect(request?.url).toBe('/rest/api/3/myself')
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${s.fake.options.token}`).toString('base64')}`,
    )
    expect(request?.headers['accept-encoding']).toBeUndefined()
  })

  it('says the credentials were refused, without the token in the failure', async () => {
    const s = await setup([])
    const ctx = s.ctx(APO, { secret: new SecretValue('not-the-token-123456') })
    expect(await s.connector.test(ctx)).toEqual({ ok: false, code: 'source_auth_failed' })
    const error: unknown = await s.connector.sync(ctx, null, limits(10)).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    const shown = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`
    expect(shown).not.toContain('not-the-token-123456')
    expect(shown).not.toContain(Buffer.from(`${EMAIL}:not-the-token-123456`).toString('base64'))
    for (const r of s.fake.server.received) expect(r.url).not.toContain('not-the-token')
  })

  it('needs the credentials', async () => {
    const s = await setup([])
    expect(await s.connector.test(s.ctx([], { secret: null }))).toEqual({
      ok: false,
      code: 'source_credentials_missing',
    })
  })
})

describe('the perimeter options', () => {
  it('are the projects of the site, by id, page by page', async () => {
    const s = await setup([], { projectPageSize: 1 })
    const options = await s.connector.perimeterOptions(s.ctx([]))
    expect(options).toEqual([
      { id: 'project:10000', label: 'Apollo Ünità (APO)' },
      { id: 'project:10001', label: 'Borea (BOR)' },
    ])
    expect(
      s.fake.server.received.map((r) => new URL(r.url, 'http://x').searchParams.get('startAt')),
    ).toEqual(['0', '1'])
  })

  it('fail rather than cut the list when the site has more pages than are read', async () => {
    const projects = Array.from({ length: 51 }, (_, i) => ({
      id: String(20000 + i),
      key: `P${i}`,
      name: `Progetto ${i}`,
    }))
    // One project a page: 50 pages hold 50 projects, the 51st is never cut off in silence.
    const s = await setup([], { projects, projectPageSize: 1 })
    expect(await codeOf(s.connector.perimeterOptions(s.ctx([])))).toBe('response_too_large')
    expect(s.fake.server.received).toHaveLength(50)
  })

  it('are read again at every sync, page by page, the chosen ones only', async () => {
    const s = await setup([jiraIssue(1, 'BOR-1', BOREA, { updated: at(1) })], {
      projectPageSize: 1,
    })
    const perimeter = ['project:10000', 'project:10001']
    const batch = await s.connector.sync(s.ctx(perimeter), null, limits(10))
    expect(records(batch).map((r) => r.perimeter)).toEqual([['project:10001']])
    const lookups = s.fake.server.received.filter((r) => r.url.includes('/project/search'))
    expect(lookups).toHaveLength(2)
    expect(new URL(lookups[0]?.url ?? '', 'http://x').searchParams.getAll('id')).toEqual([
      '10000',
      '10001',
    ])
  })
})

describe('a sync', () => {
  it('reads the declared fields into a tracker record and an «Export Jira» of them', async () => {
    const s = await setup([
      jiraIssue(10042, 'APO-42', APOLLO, {
        updated: '2026-11-01T10:00:00.123+0000',
        type: 'Bug',
        summary: 'Login lento',
        status: 'Done',
        assignee: { displayName: 'Lucia Bianchi', emailAddress: 'lucia.bianchi@example.test' },
        priority: 'High',
        storyPoints: 5,
        sprints: [
          { name: 'Sprint 1', state: 'closed' },
          { name: 'Sprint 2', state: 'active' },
        ],
        labels: ['perf', 'login'],
        parent: 'APO-7',
        created: '2026-10-20T08:00:00.000+0200',
        resolved: '2026-11-01T09:00:00.000+0000',
        due: '2026-11-15',
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Il login impiega ' },
                { type: 'text', text: '8 s', marks: [{ type: 'strong' }] },
                { type: 'hardBreak' },
                { type: 'text', text: 'Vedi "log" & trace' },
              ],
            },
          ],
        },
        comments: [jiraComment(1, '2026-10-30T10:00:00.000+0000', '=SUM(A1)', 'Anna Verdi')],
      }),
    ])
    const batch = await s.connector.sync(s.ctx(APO), null, limits(10))
    const [record] = records(batch)
    expect(record).toMatchObject({
      externalId: '10042',
      version: '2026-11-01T10:00:00.123Z',
      title: 'Login lento',
      originAt: new Date('2026-11-01T10:00:00.123Z'),
      perimeter: APO,
      url: 'https://contoso.atlassian.net/browse/APO-42',
      people: [
        { displayName: 'Lucia Bianchi', email: 'lucia.bianchi@example.test' },
        { displayName: 'Anna Verdi', email: 'anna.verdi@example.test' },
      ],
      record: {
        key: 'APO-42',
        type: 'Bug',
        status: 'Done',
        statusCategory: 'indeterminate',
        assignee: 'Lucia Bianchi',
        priority: 'High',
        storyPoints: 5,
        sprint: 'Sprint 2',
        sprints: ['Sprint 1', 'Sprint 2'],
        projectKey: 'APO',
        labels: ['perf', 'login'],
        parentKey: 'APO-7',
        createdAt: '2026-10-20T06:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.123Z',
        resolvedAt: '2026-11-01T09:00:00.000Z',
        dueDate: '2026-11-15',
        description: 'Il login impiega 8 s\nVedi "log" & trace',
        comments: [
          { author: 'Anna Verdi', createdAt: '2026-10-30T10:00:00.000Z', text: '=SUM(A1)' },
        ],
      },
    })
    const exported = exportOf(batch) as ExternalItem & { bytes: Uint8Array }
    expect(exported).toMatchObject({
      title: 'Export Jira del 05/11 10:20',
      mediaType: 'text/csv',
      kind: 'backlog_export',
      perimeter: APO,
    })
    const csv = new TextDecoder().decode(exported.bytes).split('\r\n')
    expect(csv[0]).toBe(
      'Issue id,Issue key,Issue Type,Summary,Status,Assignee,Priority,Sprint,Story Points,Project key,Labels,Parent,Created,Updated,Resolved,Due date,Description,Comments',
    )
    expect(csv[1]).toContain('10042,APO-42,Bug,Login lento,Done,Lucia Bianchi,High,Sprint 2,5,APO,')
    // A comment that looks like a formula is neutralized in the export.
    expect(csv[1]).toContain('2026-10-30T10:00:00.000Z; Anna Verdi; =SUM(A1)')
    // As of the start of the settle window: 10 minutes before the sync.
    expect(batch).toMatchObject({ done: true, dataAsOf: new Date('2026-11-05T09:20:00.000Z') })
    expect(batch.nextCursor).toEqual({ updated: '2026-11-01T10:00:00.123Z', ids: ['10042'] })

    expect(s.fake.fieldLists).toEqual([
      'summary,issuetype,status,assignee,priority,project,created,updated,resolutiondate,duedate,labels,parent,description,comment,customfield_10016,customfield_10020',
    ])
    expect(new URL(searches(s)[0]?.url ?? '', 'http://x').searchParams.get('maxResults')).toBe(
      '100',
    )
    for (const r of s.fake.server.received) expect(r.headers['accept-encoding']).toBeUndefined()
  })

  it('never asks, reads or keeps worklog and time tracking, even when the system gives them', async () => {
    const s = await setup([jiraIssue(1, 'APO-1', APOLLO, { updated: at(0) })])
    s.fake.allFields = true
    const batch = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(records(batch)).toHaveLength(1)
    const kept = JSON.stringify(records(batch).map((r) => r.record))
    const csv = new TextDecoder().decode(exportOf(batch)?.bytes)
    for (const name of TIME_FIELDS) {
      expect(kept, name).not.toContain(name)
      expect(csv.toLowerCase(), name).not.toContain(name)
      for (const r of s.fake.server.received) expect(r.url.toLowerCase(), name).not.toContain(name)
    }
    expect(kept).not.toContain('3h 20m')
    expect(csv).not.toContain('3h 20m')
    expect(kept).not.toContain('12000')
    for (const r of s.fake.server.received) expect(r.url).not.toContain('*all')
  })

  it('leaves a field the system does not give empty, never guessed', async () => {
    const issue = jiraIssue(1, 'APO-1', APOLLO, { updated: at(0), assignee: null })
    const s = await setup([issue])
    const config = { ...s.config, storyPointsField: null, sprintField: null }
    const batch = await s.connector.sync(s.ctx(APO, { config }), null, limits(5))
    expect(records(batch)[0]?.record).toMatchObject({
      assignee: null,
      storyPoints: null,
      sprint: null,
      sprints: [],
      labels: [],
      parentKey: null,
      resolvedAt: null,
      dueDate: null,
      description: null,
      comments: [],
    })
    expect(records(batch)[0]?.people).toEqual([])
    expect(s.fake.fieldLists[0]).not.toContain('customfield')
  })

  it('keeps only the chosen projects, by id, and drops what the system returns outside them', async () => {
    const s = await setup([
      jiraIssue(1, 'APO-1', APOLLO, { updated: at(1) }),
      jiraIssue(2, 'BOR-1', BOREA, { updated: at(2) }),
    ])
    const batch = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(records(batch).map((r) => r.externalId)).toEqual(['1'])
    expect(s.fake.searches[0]).toBe('project in (10000) ORDER BY updated ASC, key ASC')

    s.fake.leakPerimeter = true
    const leaked = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(records(leaked).map((r) => [r.externalId, r.perimeter])).toEqual([['1', APO]])
    expect(new TextDecoder().decode(exportOf(leaked)?.bytes)).not.toContain('BOR-1')
    // Read past: the cursor is on the dropped issue, which never comes back.
    expect(leaked.nextCursor).toEqual({ updated: at(2), ids: ['2'] })
  })

  it('refuses a perimeter none of whose projects exists any more', async () => {
    const s = await setup([])
    expect(await codeOf(s.connector.sync(s.ctx(['project:99999']), null, limits(10)))).toBe(
      'source_not_configured',
    )
    expect(await codeOf(s.connector.sync(s.ctx(['area:1']), null, limits(10)))).toBe(
      'source_not_configured',
    )
  })

  it('pages through the search with nextPageToken, 100 at a time, within the batch limit', async () => {
    const list = Array.from({ length: 250 }, (_, i) =>
      jiraIssue(i + 1, `APO-${i + 1}`, APOLLO, { updated: at(i % 60, Math.floor(i / 60), i) }),
    )
    const s = await setup(list)
    const batch = await s.connector.sync(s.ctx(APO), null, limits(1000))
    expect(records(batch)).toHaveLength(250)
    expect(
      searches(s).map((r) => new URL(r.url, 'http://x').searchParams.get('nextPageToken')),
    ).toEqual([null, '100', '200'])
    expect(batch.done).toBe(true)
  })

  it('pages through the items: each batch within its limit, one export per batch, no duplicates', async () => {
    const list = Array.from({ length: 7 }, (_, i) =>
      jiraIssue(i + 1, `APO-${i + 1}`, APOLLO, { updated: at(i) }),
    )
    const s = await setup(list)
    const { batches } = await syncAll(s, APO, 3)
    expect(batches.map((b) => b.items.length)).toEqual([3, 3, 3, 2])
    expect(batches.map((b) => b.done)).toEqual([false, false, false, true])
    expect(batches.flatMap(records).map((r) => r.externalId)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ])
    const exports = batches.map(exportOf)
    expect(exports.every((e) => e?.kind === 'backlog_export')).toBe(true)
    expect(new Set(exports.map((e) => e?.externalId)).size).toBe(4)
  })

  it('resumes from the cursor: what changed in the same minute and at the same instant, never twice', async () => {
    const list = [
      jiraIssue(1, 'APO-1', APOLLO, { updated: at(1) }),
      // Three issues at one instant and one later in the same minute.
      jiraIssue(5, 'APO-5', APOLLO, { updated: at(2, 10, 500) }),
      jiraIssue(3, 'APO-3', APOLLO, { updated: at(2, 10, 500) }),
      jiraIssue(4, 'APO-4', APOLLO, { updated: at(2, 10, 500) }),
      jiraIssue(2, 'APO-2', APOLLO, { updated: at(2, 40) }),
    ]
    const s = await setup(list)
    // One issue per batch (and its export): the tie splits across batches.
    const first = await syncAll(s, APO, 2)
    expect(first.batches.flatMap(records).map((r) => r.externalId)).toEqual([
      '1',
      '3',
      '4',
      '5',
      '2',
    ])
    expect(first.batches.map((b) => b.nextCursor)).toContainEqual({
      updated: at(2, 10, 500),
      ids: ['3', '4'],
    })
    expect(first.cursor).toEqual({ updated: at(2, 40), ids: ['2'] })

    // Nothing changed: nothing comes back, the cursor stays.
    const again = await s.connector.sync(s.ctx(APO), first.cursor, limits(10))
    expect(again.items).toEqual([])
    expect(again).toMatchObject({ done: true, nextCursor: first.cursor })
    // Relative to Jira's clock, no zone: from 10:02:40 on 1/11 to 09:30 on 5/11 is 5,727⅓
    // minutes, rounded up, plus 15 minutes of margin for the clocks.
    expect(s.fake.searches.at(-1)).toBe(
      'project in (10000) AND updated >= "-5743m" ORDER BY updated ASC, key ASC',
    )

    s.fake.options.issues[0] = jiraIssue(1, 'APO-1', APOLLO, {
      updated: at(2, 40),
      status: 'Done',
    })
    s.fake.options.issues.push(jiraIssue(9, 'APO-9', APOLLO, { updated: at(6) }))
    const next = await s.connector.sync(s.ctx(APO), first.cursor, limits(10))
    expect(records(next).map((r) => [r.externalId, r.version])).toEqual([
      ['1', at(2, 40)],
      ['9', at(6)],
    ])
    expect(next.nextCursor).toEqual({ updated: at(6), ids: ['9'] })
  })

  it('misses nothing right after the cursor when Jira’s clock is ahead within the margin', async () => {
    const s = await setup([
      jiraIssue(1, 'APO-1', APOLLO, { updated: at(2, 5) }),
      jiraIssue(2, 'APO-2', APOLLO, { updated: at(2, 5, 1) }),
    ])
    const first = await s.connector.sync(s.ctx(APO), null, limits(2))
    expect(first.nextCursor).toEqual({ updated: at(2, 5), ids: ['1'] })
    s.fake.now = new Date(NOW.getTime() + 14 * 60_000)
    const next = await s.connector.sync(s.ctx(APO), first.nextCursor, limits(10))
    expect(records(next).map((r) => r.externalId)).toEqual(['2'])
    // No account call for a time zone: relative dates need none.
    expect(s.fake.server.received.some((r) => r.url.includes('/myself'))).toBe(false)
  })

  it('leaves what changed in the last 10 minutes to the next sync, so a late index misses nothing', async () => {
    const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
    const s = await setup([
      jiraIssue(1, 'APO-1', APOLLO, { updated: at(0) }),
      // Changed 5 minutes ago, not yet in the search index; the next one is.
      jiraIssue(2, 'APO-2', APOLLO, { updated: minutesAgo(5) }),
      jiraIssue(3, 'APO-3', APOLLO, { updated: minutesAgo(3) }),
    ])
    s.fake.unindexed.add('2')
    const first = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(records(first).map((r) => r.externalId)).toEqual(['1'])
    expect(first).toMatchObject({
      done: true,
      nextCursor: { updated: at(0), ids: ['1'] },
      dataAsOf: new Date(NOW.getTime() - 10 * 60_000),
    })

    s.fake.unindexed.clear()
    const later = new Date(NOW.getTime() + 20 * 60_000)
    s.fake.now = later
    const next = await s.connector.sync(
      s.ctx(APO, { now: () => later }),
      first.nextCursor,
      limits(10),
    )
    expect(records(next).map((r) => r.externalId)).toEqual(['2', '3'])
  })

  it('fails when Jira says more pages follow but gives no token to them', async () => {
    const list = Array.from({ length: 150 }, (_, i) =>
      jiraIssue(i + 1, `APO-${i + 1}`, APOLLO, { updated: at(i % 60, Math.floor(i / 60)) }),
    )
    const s = await setup(list)
    s.fake.dropNextPageToken = true
    expect(await codeOf(s.connector.sync(s.ctx(APO), null, limits(1000)))).toBe(
      'source_bad_response',
    )
    // Refused on the answer itself, never by asking again without a token.
    expect(searches(s)).toHaveLength(1)
  })

  it('fails and keeps the cursor when the system answers out of the update order', async () => {
    const s = await setup([
      jiraIssue(1, 'APO-1', APOLLO, { updated: at(0) }),
      // APO-2 changed after APO-3 within the same minute.
      jiraIssue(2, 'APO-2', APOLLO, { updated: at(1, 50) }),
      jiraIssue(3, 'APO-3', APOLLO, { updated: at(1, 10) }),
    ])
    const first = await s.connector.sync(s.ctx(APO), null, limits(2))
    expect(first.nextCursor).toEqual({ updated: at(0), ids: ['1'] })
    s.fake.orderByMinuteOnly = true
    expect(await codeOf(s.connector.sync(s.ctx(APO), first.nextCursor, limits(10)))).toBe(
      'source_bad_response',
    )
    s.fake.orderByMinuteOnly = false
    const next = await s.connector.sync(s.ctx(APO), first.nextCursor, limits(10))
    expect(records(next).map((r) => r.externalId)).toEqual(['3', '2'])
  })

  it('keeps the last 50 comments, reading them apart when the search gives only the first', async () => {
    const comments = Array.from({ length: 60 }, (_, i) =>
      jiraComment(i + 1, at(0, i), `commento ${i + 1}`),
    )
    const s = await setup([jiraIssue(1, 'APO-1', APOLLO, { updated: at(5), comments })])
    const inline = await s.connector.sync(s.ctx(APO), null, limits(10))
    const texts = (b: SyncBatch<JiraCursor>) =>
      ((records(b)[0]?.record?.comments ?? []) as { text: string }[]).map((c) => c.text)
    expect(texts(inline)).toHaveLength(50)
    expect(texts(inline)[0]).toBe('commento 11')
    expect(texts(inline).at(-1)).toBe('commento 60')
    expect(s.fake.server.received.some((r) => r.url.includes('/comment'))).toBe(false)

    s.fake.inlineComments = 20
    const apart = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(texts(apart)).toEqual(texts(inline))
    const call = s.fake.server.received.find((r) => r.url.includes('/comment'))
    expect(call?.url).toBe('/rest/api/3/issue/1/comment?orderBy=-created&maxResults=50')
  })

  it('stops, never skips, when more issues changed at one instant than a cursor holds', async () => {
    const list = Array.from({ length: 1001 }, (_, i) =>
      jiraIssue(i + 1, `APO-${i + 1}`, APOLLO, { updated: at(3, 0, 7) }),
    )
    const s = await setup(list)
    expect(await codeOf(s.connector.sync(s.ctx(APO), null, limits(2000)))).toBe(
      'source_bad_response',
    )
  })

  it('waits when Jira asks to slow down and goes on', async () => {
    const s = await setup([jiraIssue(1, 'APO-1', APOLLO, { updated: at(1) })])
    s.fake.failNext.set('/rest/api/3/search/jql', 429)
    const batch = await s.connector.sync(s.ctx(APO), null, limits(10))
    expect(records(batch)).toHaveLength(1)
  })

  it('never writes nor reads worklogs: such calls are refused before the network', async () => {
    const s = await setup([])
    const http = s.ctx([]).http
    const base = `${s.fake.server.origin}/rest/api/3`
    const headers = { authorization: 'Basic x', 'content-type': 'application/json' }
    const attempts = [
      { method: 'POST', url: `${base}/issue` },
      { method: 'PUT', url: `${base}/issue/10042` },
      { method: 'DELETE', url: `${base}/issue/10042` },
      { method: 'POST', url: `${base}/issue/10042/comment` },
      { method: 'POST', url: `${base}/search/jql` },
      { method: 'POST', url: `${base}/issue/10042/transitions` },
      { method: 'GET', url: `${base}/issue/10042/worklog` },
      { method: 'GET', url: `${base}/issue/10042` },
    ]
    for (const a of attempts) {
      const code = await codeOf(http.request({ ...a, headers, body: '{}' }))
      expect(code, `${a.method} ${a.url}`).toBe('call_blocked')
    }
    expect(s.blocked.map((b) => b.reason)).toEqual([
      'path_not_allowed',
      'method_not_allowed',
      'method_not_allowed',
      'method_not_allowed',
      'method_not_allowed',
      'path_not_allowed',
      'path_not_allowed',
      'path_not_allowed',
    ])
    expect(s.fake.server.received).toEqual([])
  })
})

describe('the listing of a reconciliation', () => {
  it('gives the ids of every issue of the chosen projects, page by page, ids only', async () => {
    const issues = Array.from({ length: 150 }, (_, i) =>
      jiraIssue(20_000 + i, `APO-${i + 1}`, APOLLO, { updated: at(i % 50) }),
    )
    const s = await setup([...issues, jiraIssue(30_000, 'BOR-1', BOREA, { updated: at(1) })])
    const listed = await s.connector.listIds?.(s.ctx(APO))
    expect(listed?.ids).toHaveLength(150)
    expect(listed?.ids).not.toContain('30000')
    expect(listed?.asOf).toEqual(NOW)
    expect(s.fake.fieldLists.every((f) => f === 'id')).toBe(true)
    expect(searches(s)).toHaveLength(2)
    expect(s.fake.searches.every((q) => !q.includes('updated'))).toBe(true)
    // By key: a stable order while issues change between pages.
    expect(s.fake.searches.every((q) => q.endsWith('ORDER BY key ASC'))).toBe(true)
  })

  it('fails the sync too when a part of the perimeter is no longer on the site', async () => {
    const s = await setup([jiraIssue(20_000, 'APO-1', APOLLO, { updated: at(1) })])
    const sync = s.connector.sync(s.ctx([...APO, 'project:99999']), null, limits(10))
    expect(await codeOf(sync)).toBe('source_not_found')
  })

  it('fails rather than list a perimeter only part of which is still on the site', async () => {
    const s = await setup([jiraIssue(20_000, 'APO-1', APOLLO, { updated: at(1) })])
    const listing = s.connector.listIds?.(s.ctx([...APO, 'project:99999'])) as Promise<unknown>
    expect(await codeOf(listing)).toBe('source_not_found')
  })

  it('never takes a page without its way to the next as the end', async () => {
    const issues = Array.from({ length: 150 }, (_, i) =>
      jiraIssue(20_000 + i, `APO-${i + 1}`, APOLLO, { updated: at(1) }),
    )
    const s = await setup(issues)
    s.fake.dropNextPageToken = true
    const listing = s.connector.listIds?.(s.ctx(APO)) as Promise<unknown>
    expect(await codeOf(listing)).toBe('source_bad_response')
  })

  it('fails rather than give a list longer than a listing holds', async () => {
    const issues = Array.from({ length: 20_001 }, (_, i) =>
      jiraIssue(100_000 + i, `APO-${i + 1}`, APOLLO, { updated: at(1) }),
    )
    const s = await setup(issues)
    const listing = s.connector.listIds?.(s.ctx(APO)) as Promise<unknown>
    expect(await codeOf(listing)).toBe('response_too_large')
  })
})
