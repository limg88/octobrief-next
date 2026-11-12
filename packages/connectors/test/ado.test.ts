import { randomBytes } from 'node:crypto'
import {
  matchesTrackerFilter,
  type SourceId,
  workItemOf as trackerWorkItemOf,
  workItemRow,
} from '@octobrief/domain'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AdoConfig,
  type AdoCursor,
  type BlockedCall,
  type ConnectorContext,
  ConnectorError,
  createAdoConnector,
  createNetGuard,
  createSafeHttp,
  type ExternalItem,
  type SyncBatch,
} from '../src/index.ts'
import { SecretValue } from '../src/secret-value.ts'
import {
  type FakeAdo,
  type FakeAdoOptions,
  type FakeWorkItem,
  nodeIds,
  startFakeAdo,
  workItem,
} from './support/fake-ado.ts'
import { assertRulesConfined, HOSTILE_VALUES } from './support/rules-contract.ts'

const PROJECT_ID = '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c'
const PROJECT = 'Apollo Ünità'
const fakes: FakeAdo[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.server.close()))
})

const AREAS = [
  { name: 'Team A', children: [{ name: 'Backend' }] },
  { name: 'Team B' },
  { name: "Team O'Neil" },
]
const ITERATIONS = [{ name: 'Sprint 1' }, { name: 'Sprint 2' }]
const A = `${PROJECT}\\Team A`
const S1 = `${PROJECT}\\Sprint 1`
const S2 = `${PROJECT}\\Sprint 2`

interface Setup {
  fake: FakeAdo
  config: AdoConfig
  blocked: BlockedCall[]
  ids: Map<string, string>
  ctx(
    perimeter: string[],
    overrides?: Partial<ConnectorContext<AdoConfig>>,
  ): ConnectorContext<AdoConfig>
  connector: ReturnType<typeof createAdoConnector>
}

async function setup(items: FakeWorkItem[], extra: Partial<FakeAdoOptions> = {}): Promise<Setup> {
  const pat = randomBytes(20).toString('hex')
  const options: FakeAdoOptions = {
    organization: 'contoso',
    projectId: PROJECT_ID,
    projectName: PROJECT,
    pat,
    areas: AREAS,
    iterations: ITERATIONS,
    items,
    ...extra,
  }
  const fake = await startFakeAdo(options)
  fakes.push(fake)
  const connector = createAdoConnector({
    endpoint: () => ({ origin: fake.server.origin, host: fake.server.host, prefix: ['contoso'] }),
  })
  const config = connector.parseConfig({
    organization: 'contoso',
    host: 'dev.azure.com',
    projectId: extra.projectId === undefined ? PROJECT_ID : extra.projectId,
    readOnlyToken: true,
  })
  const blocked: BlockedCall[] = []
  const ids = nodeIds(options)
  return {
    fake,
    config,
    blocked,
    ids,
    connector,
    ctx: (perimeter, overrides = {}) => {
      const cfg = overrides.config ?? config
      return {
        config: cfg,
        perimeter,
        secret: new SecretValue(pat),
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
        now: () => new Date('2026-11-05T09:30:00.000Z'),
        ...overrides,
      }
    },
  }
}

const id = (s: Setup, key: string) => s.ids.get(key) as string
const records = (b: SyncBatch<AdoCursor>) => b.items.filter((i) => i.record !== undefined)
const exportOf = (b: SyncBatch<AdoCursor>) => b.items.find((i) => i.bytes !== undefined)
/** The WIQL query of the first sync the fake received. */
function wiqlOf(s: Setup): string {
  const body = s.fake.bodies.find((b) => b.path.endsWith('wiql'))?.body as { query: string }
  return body.query
}
const limits = (maxItems: number) => ({ maxItems, signal: new AbortController().signal })

async function syncAll(s: Setup, perimeter: string[], maxItems: number, from: AdoCursor = null) {
  const batches: SyncBatch<AdoCursor>[] = []
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

describe('the Azure DevOps configuration', () => {
  const connector = createAdoConnector()
  const valid = {
    organization: 'contoso',
    host: 'dev.azure.com',
    projectId: PROJECT_ID,
    readOnlyToken: true,
  }

  it('needs an organization name, a public host and the PM declaring the token read-only', () => {
    expect(connector.parseConfig(valid)).toEqual(valid)
    expect(connector.parseConfig({ ...valid, projectId: null }).projectId).toBeNull()
    for (const raw of [
      { ...valid, readOnlyToken: false },
      { ...valid, readOnlyToken: undefined },
      { ...valid, host: 'ado.contoso.internal' },
      { ...valid, organization: 'contoso/other' },
      { ...valid, organization: '-contoso' },
      { ...valid, projectId: 'Apollo' },
      null,
      [],
    ]) {
      expect(() => connector.parseConfig(raw), JSON.stringify(raw)).toThrow(ConnectorError)
    }
  })

  it('reaches dev.azure.com/<org> or <org>.visualstudio.com, nothing else', () => {
    const cfg = connector.parseConfig(valid)
    expect(new Set(connector.rules(cfg).map((r) => r.host))).toEqual(new Set(['dev.azure.com']))
    const old = connector.parseConfig({
      ...valid,
      organization: 'Contoso',
      host: 'visualstudio.com',
    })
    expect(new Set(connector.rules(old).map((r) => r.host))).toEqual(
      new Set(['contoso.visualstudio.com']),
    )
  })

  it('reads only: GET on projects and nodes, POST only on the WIQL query and the batch read', () => {
    const rules = connector.rules(connector.parseConfig(valid))
    const shown = rules.map(
      (r) => `${r.method} ${r.path.map((p) => (p === 'segment' ? '*' : p.literal)).join('/')}`,
    )
    expect(shown.sort()).toEqual(
      [
        'GET contoso/_apis/projects',
        `GET contoso/_apis/projects/${PROJECT_ID}`,
        `GET contoso/${PROJECT_ID}/_apis/wit/classificationnodes`,
        `POST contoso/${PROJECT_ID}/_apis/wit/wiql`,
        `POST contoso/${PROJECT_ID}/_apis/wit/workitemsbatch`,
      ].sort(),
    )
    expect(rules.some((r) => r.rest)).toBe(false)
  })

  it('keeps every configuration value confined (the connectors contract)', () => {
    const cfg = (organization: string, host: AdoConfig['host']): AdoConfig => ({
      organization,
      host,
      projectId: PROJECT_ID,
      readOnlyToken: true,
    })
    assertRulesConfined(connector.rules, (v) => cfg(v, 'dev.azure.com'))
    assertRulesConfined(connector.rules, (v) => cfg(v, 'visualstudio.com'))
    // The project is an id: no hostile value is one.
    for (const value of HOSTILE_VALUES) {
      expect(
        () => connector.rules({ ...cfg('contoso', 'dev.azure.com'), projectId: value }),
        JSON.stringify(value),
      ).toThrow(ConnectorError)
    }
  })

  it('refuses an unreadable cursor', () => {
    expect(connector.parseCursor(null)).toBeNull()
    expect(connector.parseCursor({ changedAt: '2026-11-01T10:00:00.000Z', id: 3 })).toEqual({
      changedAt: '2026-11-01T10:00:00.000Z',
      id: 3,
    })
    for (const raw of [
      { changedAt: 'ieri', id: 3 },
      { changedAt: '2026-11-01' },
      { id: 1.5 },
      'x',
    ]) {
      expect(() => connector.parseCursor(raw)).toThrow()
    }
  })
})

describe('the connection test', () => {
  it('answers ok with a token Azure DevOps takes, in the Authorization header only', async () => {
    const s = await setup([])
    expect(await s.connector.test(s.ctx([]))).toEqual({ ok: true })
    const [request] = s.fake.server.received
    expect(request?.url).toMatch(new RegExp(`^/contoso/_apis/projects/${PROJECT_ID}\\?`))
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from(`:${s.fake.options.pat}`).toString('base64')}`,
    )
    expect(request?.headers['accept-encoding']).toBeUndefined()
    expect(request?.url).not.toContain(s.fake.options.pat)
  })

  it('says the credentials were refused, without the token in the failure', async () => {
    const s = await setup([])
    const ctx = s.ctx([], { secret: new SecretValue('not-the-token-123456') })
    expect(await s.connector.test(ctx)).toEqual({ ok: false, code: 'source_auth_failed' })
    // The sign-in page Azure DevOps gives instead of an answer is a refusal too.
    s.fake.failNext.set(`/contoso/_apis/projects/${PROJECT_ID}`, 203)
    expect(await s.connector.test(s.ctx([]))).toEqual({ ok: false, code: 'source_auth_failed' })
    const error: unknown = await s.connector.sync(ctx, null, limits(10)).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    const shown = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`
    expect(shown).not.toContain('not-the-token-123456')
    expect(shown).not.toContain(Buffer.from(':not-the-token-123456').toString('base64'))
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
  it('fail rather than cut the list when the organization has more pages than are read', async () => {
    const otherProjects = Array.from({ length: 50 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Progetto ${i}`,
    }))
    const s = await setup([], { projectPageSize: 1, otherProjects })
    const config = { ...s.config, projectId: null }
    expect(await codeOf(s.connector.perimeterOptions(s.ctx([], { config })))).toBe(
      'response_too_large',
    )
    expect(s.fake.server.received).toHaveLength(50)
  })

  it('list the projects of the organization, page by page, before one is chosen', async () => {
    const s = await setup([], {
      projectId: PROJECT_ID,
      projectPageSize: 2,
      otherProjects: [
        { id: '0f2d1e7c-2b3a-4c5d-8e9f-0a1b2c3d4e5f', name: 'Borea' },
        { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Cassiopea' },
        { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', name: 'Dismessa', state: 'deleting' },
      ],
    })
    const config = { ...s.config, projectId: null }
    const options = await s.connector.perimeterOptions(s.ctx([], { config }))
    expect(options.map((o) => o.label)).toEqual([PROJECT, 'Borea', 'Cassiopea'])
    expect(options[0]?.id).toBe(`project:${PROJECT_ID}`)
    expect(
      s.fake.server.received.map((r) =>
        new URL(r.url, 'http://x').searchParams.get('continuationToken'),
      ),
    ).toEqual([null, '2'])
  })

  it('are the area and iteration trees of the chosen project, children under their parent', async () => {
    const s = await setup([])
    const options = await s.connector.perimeterOptions(s.ctx([]))
    const byLabel = new Map(options.map((o) => [o.label, o]))
    expect(byLabel.get('Backend')).toEqual({
      id: id(s, `area ${A}\\Backend`),
      label: 'Backend',
      parentId: id(s, `area ${A}`),
    })
    expect(byLabel.get('Sprint 2')?.parentId).toBe(id(s, `iteration ${PROJECT}`))
    expect(options.filter((o) => o.parentId === undefined).map((o) => o.id)).toEqual([
      id(s, `area ${PROJECT}`),
      id(s, `iteration ${PROJECT}`),
    ])
  })
})

describe('a sync', () => {
  const at = (minute: number, ms = 0) =>
    new Date(Date.UTC(2026, 10, 1, 10, minute, 0, ms)).toISOString()

  it('reads the declared fields into a tracker record and an «Export ADO» of them', async () => {
    const s = await setup([
      workItem(42, {
        rev: 7,
        area: `${A}\\Backend`,
        iteration: S1,
        changedAt: '2026-11-01T10:00:00.123Z',
        type: 'Bug',
        title: 'Login lento',
        state: 'Closed',
        assignedTo: { displayName: 'Lucia Bianchi', uniqueName: 'lucia.bianchi@example.test' },
        tags: 'perf; login',
        storyPoints: 5,
        priority: 1,
        createdAt: '2026-10-20T08:30:00Z',
        closedAt: '2026-11-01T09:00:00Z',
        parent: 7,
        description:
          '<div>Il login impiega <b>8&nbsp;s</b>.<br>Vedi &quot;log&quot; &amp; trace</div>',
      }),
    ])
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(10))
    const [record] = records(batch)
    expect(record).toMatchObject({
      externalId: '42',
      version: '7',
      title: 'Login lento',
      originAt: new Date('2026-11-01T10:00:00.123Z'),
      perimeter: [id(s, `area ${A}`)],
      people: [{ displayName: 'Lucia Bianchi', email: 'lucia.bianchi@example.test' }],
      url: `${s.fake.server.origin}/contoso/${PROJECT_ID}/_workitems/edit/42`,
      record: {
        type: 'Bug',
        state: 'Closed',
        assignedTo: 'Lucia Bianchi',
        areaPath: `${A}\\Backend`,
        iterationPath: S1,
        tags: ['perf', 'login'],
        storyPoints: 5,
        priority: 1,
        createdAt: '2026-10-20T08:30:00.000Z',
        changedAt: '2026-11-01T10:00:00.123Z',
        closedAt: '2026-11-01T09:00:00.000Z',
        parentId: '7',
        description: 'Il login impiega 8 s.\nVedi "log" & trace',
      },
    })
    const exported = exportOf(batch) as ExternalItem & { bytes: Uint8Array }
    expect(exported).toMatchObject({
      title: 'Export ADO del 05/11 10:00',
      mediaType: 'text/csv',
      kind: 'backlog_export',
      originAt: s.fake.asOf,
      perimeter: [id(s, `area ${A}`)],
    })
    const csv = new TextDecoder().decode(exported.bytes).split('\r\n')
    expect(csv[0]).toBe(
      'ID,Work Item Type,Title,State,Assigned To,Area Path,Iteration Path,Tags,Story Points,Priority,Created Date,Changed Date,Closed Date,Parent,Description',
    )
    expect(csv[1]).toContain('42,Bug,Login lento,Closed,Lucia Bianchi,')
    expect(csv[1]).toContain('"Il login impiega 8 s.\nVedi ""log"" & trace"')
    expect(batch).toMatchObject({ done: true, dataAsOf: s.fake.asOf })
    expect(batch.nextCursor).toEqual({ changedAt: '2026-11-01T10:00:00.123Z', id: 42 })

    const read = s.fake.bodies.find((b) => b.path.endsWith('workitemsbatch'))?.body
    expect(read).toEqual({
      ids: [42],
      fields: [
        'System.Id',
        'System.WorkItemType',
        'System.Title',
        'System.State',
        'System.AssignedTo',
        'System.AreaPath',
        'System.IterationPath',
        'System.Tags',
        'Microsoft.VSTS.Scheduling.StoryPoints',
        'Microsoft.VSTS.Scheduling.Effort',
        'Microsoft.VSTS.Common.Priority',
        'System.CreatedDate',
        'System.ChangedDate',
        'Microsoft.VSTS.Common.ClosedDate',
        'System.Parent',
        'System.Description',
      ],
      asOf: s.fake.asOf.toISOString(),
      errorPolicy: 'omit',
    })
    for (const r of s.fake.server.received) expect(r.headers['accept-encoding']).toBeUndefined()
  })

  it('leaves a field the system does not give empty, never guessed', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(0), assignedTo: null }),
    ])
    const [record] = records(await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(5)))
    expect(record?.record).toMatchObject({
      assignedTo: null,
      tags: [],
      storyPoints: null,
      createdAt: null,
      closedAt: null,
      parentId: null,
      description: null,
    })
    expect(record?.people).toEqual([])
  })

  it('the ADO connector reads when a work item was created', async () => {
    const s = await setup([
      workItem(5, {
        area: A,
        iteration: S1,
        changedAt: at(5),
        type: 'Bug',
        createdAt: '2026-09-15T07:45:00.5Z',
      }),
    ])
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(5))
    const [record] = records(batch)
    expect(record?.record).toMatchObject({ createdAt: '2026-09-15T07:45:00.500Z' })
    // Read only: the creation date is one more field of the same batch read, nothing else asked.
    const asked = s.fake.bodies.find((b) => b.path.endsWith('workitemsbatch'))?.body as {
      fields: string[]
    }
    expect(asked.fields).toContain('System.CreatedDate')
    // The only bodies sent are the two read queries of Azure DevOps (WIQL and the batch read).
    expect(
      s.fake.bodies.every((b) => b.path.endsWith('/wiql') || b.path.endsWith('/workitemsbatch')),
    ).toBe(true)
    // The tracker reads it as it reads the creation date of a Jira issue.
    const item = trackerWorkItemOf({
      sourceId: '00000000-0000-4000-8000-000000000005' as SourceId,
      kind: 'ado',
      externalId: '5',
      url: null,
      fields: record?.record as Record<string, unknown>,
    })
    expect(item.created).toEqual(new Date('2026-09-15T07:45:00.500Z'))
    expect(workItemRow(item).created).toBe('2026-09-15')
    expect(matchesTrackerFilter(item, { dates: { field: 'created', to: '2026-09-15' } })).toBe(true)
    expect(matchesTrackerFilter(item, { dates: { field: 'created', to: '2026-09-14' } })).toBe(
      false,
    )
    const csv = new TextDecoder().decode((exportOf(batch) as { bytes: Uint8Array }).bytes)
    expect(csv.split('\r\n')[1]).toContain(',2026-09-15T07:45:00.500Z,')
  })

  it('an ADO item without a creation date stays not deduced', async () => {
    const s = await setup([
      workItem(6, { area: A, iteration: S1, changedAt: at(6) }),
      workItem(7, { area: A, iteration: S1, changedAt: at(7), createdAt: 'non una data' }),
    ])
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(5))
    const read = records(batch)
    expect(read.map((r) => [r.externalId, r.record?.createdAt])).toEqual([
      ['6', null],
      ['7', null],
    ])
    // A record kept before the connector read the date has no such field: still never guessed,
    // neither from the last change nor from anything else, and no date filter takes it.
    const first = (read[0]?.record ?? {}) as Record<string, unknown>
    const { createdAt: _, ...older } = first
    for (const fields of [first, read[1]?.record, older]) {
      const item = trackerWorkItemOf({
        sourceId: '00000000-0000-4000-8000-000000000006' as SourceId,
        kind: 'ado',
        externalId: '6',
        url: null,
        fields: fields as Record<string, unknown>,
      })
      expect(item.created).toBeNull()
      expect(item.changed).not.toBeNull()
      expect(matchesTrackerFilter(item, { dates: { field: 'created', to: '2099-12-31' } })).toBe(
        false,
      )
    }
  })

  it('keeps only the chosen areas, with their children, and says which choice covers each item', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: `${A}\\Backend`, iteration: S2, changedAt: at(2) }),
      workItem(3, { area: `${PROJECT}\\Team B`, iteration: S1, changedAt: at(3) }),
      workItem(4, { area: `${PROJECT}\\Team O'Neil`, iteration: S1, changedAt: at(4) }),
    ])
    const perimeter = [id(s, `area ${A}`), id(s, `area ${PROJECT}\\Team O'Neil`)]
    const batch = await s.connector.sync(s.ctx(perimeter), null, limits(10))
    expect(records(batch).map((r) => [r.externalId, r.perimeter])).toEqual([
      ['1', [id(s, `area ${A}`)]],
      ['2', [id(s, `area ${A}`)]],
      ['4', [id(s, `area ${PROJECT}\\Team O'Neil`)]],
    ])
    const query = wiqlOf(s)
    expect(query).toContain(`[System.AreaPath] UNDER '${A}'`)
    expect(query).toContain(`[System.AreaPath] UNDER '${PROJECT}\\Team O''Neil'`)
  })

  it('declares the deepest choice when a parent and its child are both chosen', async () => {
    const s = await setup([workItem(2, { area: `${A}\\Backend`, iteration: S2, changedAt: at(2) })])
    const perimeter = [id(s, `area ${A}`), id(s, `area ${A}\\Backend`)]
    const [record] = records(await s.connector.sync(s.ctx(perimeter), null, limits(10)))
    expect(record?.perimeter).toEqual([id(s, `area ${A}\\Backend`)])
  })

  it('keeps an item only under a chosen area and a chosen iteration when both are chosen', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: A, iteration: S2, changedAt: at(2) }),
    ])
    const perimeter = [id(s, `area ${A}`), id(s, `iteration ${S1}`)]
    const batch = await s.connector.sync(s.ctx(perimeter), null, limits(10))
    expect(records(batch).map((r) => [r.externalId, r.perimeter])).toEqual([
      ['1', [id(s, `area ${A}`), id(s, `iteration ${S1}`)]],
    ])
  })

  it('reads every work item under the root area of the project when the root is chosen', async () => {
    const s = await setup([
      workItem(1, { area: PROJECT, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: A, iteration: S1, changedAt: at(2) }),
      workItem(3, { area: `${PROJECT}\\Team B`, iteration: S2, changedAt: at(3) }),
    ])
    const root = id(s, `area ${PROJECT}`)
    const batch = await s.connector.sync(s.ctx([root]), null, limits(10))
    expect(records(batch).map((r) => [r.externalId, r.perimeter])).toEqual([
      ['1', [root]],
      ['2', [root]],
      ['3', [root]],
    ])
    expect(wiqlOf(s)).toContain(`[System.AreaPath] UNDER '${PROJECT}'`)
    expect(wiqlOf(s)).not.toContain('[System.ChangedDate] >=')
  })

  it('counts what it read past, outside the perimeter or not readable, never silently', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: `${PROJECT}\\Team B`, iteration: S1, changedAt: at(2) }),
      workItem(3, { area: A, iteration: S1, changedAt: at(3) }),
    ])
    s.fake.leakPerimeter = true
    s.fake.unreadable.add(3)
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(10))
    expect(records(batch).map((r) => r.externalId)).toEqual(['1'])
    expect(batch.skipped).toEqual({ outside_perimeter: 1, not_readable: 1 })
  })

  it('drops what the system returns outside the perimeter and reads past it', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: `${PROJECT}\\Team B`, iteration: S1, changedAt: at(2) }),
    ])
    s.fake.leakPerimeter = true
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(10))
    expect(records(batch).map((r) => r.externalId)).toEqual(['1'])
    expect(exportOf(batch)?.bytes).toBeDefined()
    expect(new TextDecoder().decode(exportOf(batch)?.bytes)).not.toContain('Team B')
    expect(batch.nextCursor).toEqual({ changedAt: at(2), id: 2 })
  })

  it('refuses a perimeter none of whose choices is in the project any more', async () => {
    const s = await setup([])
    expect(await codeOf(s.connector.sync(s.ctx(['area:999999']), null, limits(10)))).toBe(
      'source_not_configured',
    )
    const noProject = { ...s.config, projectId: null }
    expect(
      await codeOf(s.connector.sync(s.ctx(['area:1'], { config: noProject }), null, limits(10))),
    ).toBe('source_not_configured')
  })

  it('pages through the items: each batch within its limit, one export per batch, no duplicates', async () => {
    const list = Array.from({ length: 7 }, (_, i) =>
      workItem(i + 1, { area: A, iteration: S1, changedAt: at(i) }),
    )
    const s = await setup(list)
    const { batches } = await syncAll(s, [id(s, `area ${A}`)], 3)
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

  it('reads the work items in groups of 200', async () => {
    const list = Array.from({ length: 450 }, (_, i) =>
      workItem(i + 1, { area: A, iteration: S1, changedAt: at(i % 60, i) }),
    )
    const s = await setup(list)
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(1000))
    expect(records(batch)).toHaveLength(450)
    const groups = s.fake.bodies
      .filter((b) => b.path.endsWith('workitemsbatch'))
      .map((b) => (b.body as { ids: number[] }).ids.length)
    expect(groups).toEqual([200, 200, 50])
  })

  it('resumes from the cursor: only what changed after it, never twice, ties broken by id', async () => {
    const list = [
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: A, iteration: S1, changedAt: at(2, 500) }),
      workItem(3, { area: A, iteration: S1, changedAt: at(2, 500) }),
    ]
    const s = await setup(list)
    const perimeter = [id(s, `area ${A}`)]
    // One work item per batch (and its export): the tie at the same instant splits.
    const first = await syncAll(s, perimeter, 2)
    expect(first.batches.flatMap(records).map((r) => r.externalId)).toEqual(['1', '2', '3'])
    expect(first.cursor).toEqual({ changedAt: at(2, 500), id: 3 })

    // Nothing changed: nothing comes back, the cursor stays.
    const again = await s.connector.sync(s.ctx(perimeter), first.cursor, limits(10))
    expect(again.items).toEqual([])
    expect(again).toMatchObject({ done: true, nextCursor: first.cursor })

    s.fake.options.items[0] = workItem(1, { rev: 2, area: A, iteration: S1, changedAt: at(5) })
    s.fake.options.items.push(workItem(9, { area: A, iteration: S1, changedAt: at(6) }))
    s.fake.bodies.length = 0
    const next = await s.connector.sync(s.ctx(perimeter), first.cursor, limits(10))
    expect(records(next).map((r) => [r.externalId, r.version])).toEqual([
      ['1', '2'],
      ['9', '1'],
    ])
    const query = wiqlOf(s)
    // To the second, rounded down: what changed at the cursor's second is read and skipped.
    expect(query).toContain("[System.ChangedDate] >= '2026-11-01T10:02:00Z'")
    expect(query).toContain('ORDER BY [System.ChangedDate] ASC, [System.Id] ASC')
  })

  it('fails and keeps the cursor when the system answers out of the change order', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(0) }),
      workItem(2, { area: A, iteration: S1, changedAt: at(1, 900) }),
      workItem(3, { area: A, iteration: S1, changedAt: at(1, 100) }),
    ])
    const perimeter = [id(s, `area ${A}`)]
    // In order, the first item comes alone: the cursor is on it.
    const first = await s.connector.sync(s.ctx(perimeter), null, limits(2))
    expect(first.nextCursor).toEqual({ changedAt: at(0), id: 1 })
    s.fake.orderBySecondOnly = true
    // 2 (…:01.900) comes before 3 (…:01.100): no batch, so no cursor past what was skipped.
    expect(await codeOf(s.connector.sync(s.ctx(perimeter), first.nextCursor, limits(10)))).toBe(
      'source_bad_response',
    )
    s.fake.orderBySecondOnly = false
    const next = await s.connector.sync(s.ctx(perimeter), first.nextCursor, limits(10))
    expect(records(next).map((r) => r.externalId)).toEqual(['3', '2'])
  })

  it('waits when Azure DevOps asks to slow down and goes on', async () => {
    const s = await setup([workItem(1, { area: A, iteration: S1, changedAt: at(1) })])
    s.fake.failNext.set(`/contoso/${PROJECT_ID}/_apis/wit/wiql`, 429)
    const batch = await s.connector.sync(s.ctx([id(s, `area ${A}`)]), null, limits(10))
    expect(records(batch)).toHaveLength(1)
  })

  it('never writes: a change, a creation or a deletion is refused before the network', async () => {
    const s = await setup([])
    const http = s.ctx([]).http
    const base = `${s.fake.server.origin}/contoso/${PROJECT_ID}/_apis/wit`
    const auth = { authorization: 'Basic x', 'content-type': 'application/json-patch+json' }
    const attempts = [
      { method: 'PATCH', url: `${base}/workitems/42?api-version=7.1` },
      { method: 'POST', url: `${base}/workitems/$Task?api-version=7.1` },
      { method: 'DELETE', url: `${base}/workitems/42?api-version=7.1` },
      { method: 'PUT', url: `${base}/classificationnodes?api-version=7.1` },
      { method: 'POST', url: `${base}/classificationnodes?api-version=7.1` },
      { method: 'POST', url: `${base}/workitemsbatch/x?api-version=7.1` },
    ]
    for (const a of attempts) {
      const code = await codeOf(http.request({ ...a, headers: auth, body: '[]' }))
      expect(code, `${a.method} ${a.url}`).toBe('call_blocked')
    }
    expect(s.blocked.map((b) => b.reason)).toEqual([
      'method_not_allowed',
      'path_not_allowed',
      'method_not_allowed',
      'method_not_allowed',
      'method_not_allowed',
      'path_not_allowed',
    ])
    expect(s.fake.server.received).toEqual([])
  })
})

describe('the listing of a reconciliation', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute, 0)).toISOString()

  it('gives the ids of every work item in the perimeter now, whatever its change date', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: `${A}\\Backend`, iteration: S2, changedAt: at(2) }),
      workItem(3, { area: `${PROJECT}\\Team B`, iteration: S1, changedAt: at(3) }),
    ])
    const listed = await s.connector.listIds?.(s.ctx([id(s, `area ${A}`)]))
    expect(listed?.ids).toEqual(['1', '2'])
    expect(listed?.asOf).toEqual(s.fake.asOf)
    const query = wiqlOf(s)
    expect(query).toContain(`[System.AreaPath] UNDER '${A}'`)
    expect(query).not.toContain('ChangedDate')
    // Ids only: no work item is read.
    expect(s.fake.bodies.some((b) => b.path.endsWith('workitemsbatch'))).toBe(false)
  })

  it('keeps the iterations of the perimeter in the listing', async () => {
    const s = await setup([
      workItem(1, { area: A, iteration: S1, changedAt: at(1) }),
      workItem(2, { area: A, iteration: S2, changedAt: at(2) }),
    ])
    const listed = await s.connector.listIds?.(
      s.ctx([id(s, `area ${A}`), id(s, `iteration ${S1}`)]),
    )
    expect(listed?.ids).toEqual(['1'])
  })

  it('fails rather than give a list the system may have cut', async () => {
    const many = Array.from({ length: 20_000 }, (_, i) =>
      workItem(i + 1, { area: A, iteration: S1, changedAt: at(1) }),
    )
    const s = await setup(many)
    const listing = s.connector.listIds?.(s.ctx([id(s, `area ${A}`)])) as Promise<unknown>
    expect(await codeOf(listing)).toBe('response_too_large')
  })

  it('refuses a perimeter none of whose choices is in the project any more', async () => {
    const s = await setup([])
    const listing = s.connector.listIds?.(s.ctx(['area:999'])) as Promise<unknown>
    expect(await codeOf(listing)).toBe('source_not_configured')
  })

  it('fails the sync too when a part of the perimeter is no longer in the project', async () => {
    const s = await setup([workItem(1, { area: A, iteration: S1, changedAt: at(1) })])
    const sync = s.connector.sync(s.ctx([id(s, `area ${A}`), 'area:999']), null, limits(10))
    expect(await codeOf(sync)).toBe('source_not_found')
  })

  it('fails rather than list a perimeter only part of which is still in the project', async () => {
    const s = await setup([workItem(1, { area: A, iteration: S1, changedAt: at(1) })])
    const listing = s.connector.listIds?.(
      s.ctx([id(s, `area ${A}`), 'area:999']),
    ) as Promise<unknown>
    expect(await codeOf(listing)).toBe('source_not_found')
  })
})
