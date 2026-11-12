import type { Delivery, ExternalDocument, User } from '@octobrief/domain'
import { InvalidSourceError } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { ApplicationError } from '../src/errors.ts'
import { addMember, createProject } from '../src/use-cases/projects.ts'
import {
  createScheduleSyncHandler,
  createSource,
  createSyncSourceHandler,
  deleteSource,
  INGEST_TOKEN_PREFIX,
  ingestDelivery,
  listSources,
  requestSync,
  rotateIngestToken,
} from '../src/use-cases/sources.ts'
import {
  FakeFeeds,
  FakeVault,
  InMemoryBlobs,
  InMemoryDocuments,
  InMemoryJobQueue,
  InMemoryProjects,
  InMemorySources,
  InMemoryUsers,
  RecordingLogger,
} from './fakes.ts'

const person = (id: string, role: User['role'] = 'pm'): User => ({
  id,
  displayName: id,
  email: `${id}@example.test`,
  role,
  locale: 'it',
})

const mail = (externalId: string, version: string, text: string): ExternalDocument => ({
  externalId,
  version,
  title: `Mail ${externalId}`,
  mediaType: 'text/markdown',
  bytes: new TextEncoder().encode(text),
  originAt: new Date('2026-11-10T08:00:00Z'),
  url: null,
  people: [{ displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true }],
})

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  documents: [],
  records: [],
  rows: [],
  removed: [],
  dataAsOf: new Date('2026-11-12T08:00:00Z'),
  ...over,
})

async function setup() {
  const users = new InMemoryUsers()
  const projects = new InMemoryProjects(users)
  const documents = new InMemoryDocuments(projects, users)
  const sources = new InMemorySources(documents)
  const blobs = new InMemoryBlobs()
  const queue = new InMemoryJobQueue()
  const feeds = new FakeFeeds()
  const vault = new FakeVault()
  const logger = new RecordingLogger()
  const deps = { users, projects, sources, feeds, vault, queue }
  const store = { sources, items: sources, blobs, jobs: queue }
  const paola = users.add(person('paola'))
  const marco = users.add(person('marco'))
  const olga = users.add(person('olga'))
  const project = await createProject(deps, paola, { name: 'Borea' })
  await addMember(deps, paola, project.slug, 'marco@example.test')
  const jobs = () => [...queue.jobs.values()].map((job) => job.name)
  const sync = createSyncSourceHandler({
    sync: sources,
    items: sources,
    feeds,
    vault,
    blobs,
    jobs: queue,
    logger,
  })
  return {
    deps,
    store,
    sources,
    documents,
    blobs,
    feeds,
    logger,
    paola,
    marco,
    olga,
    project,
    jobs,
    sync,
  }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof ApplicationError) return error.code
      throw error
    },
  )

describe('connecting sources', () => {
  it('gives a pushing source a token once and stores only its hash', async () => {
    const { deps, sources, paola, marco, project } = await setup()
    const { source, ingestToken } = await createSource(deps, paola, project.slug, {
      kind: 'm365',
      name: ' Posta  Borea ',
    })
    expect(source).toMatchObject({ kind: 'm365', name: 'Posta Borea', perimeter: [] })
    expect(ingestToken?.startsWith(INGEST_TOKEN_PREFIX)).toBe(true)
    const stored = sources.rows.get(source.id)
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.tokenHash).not.toContain(ingestToken as string)
    expect(await listSources(deps, marco, project.slug)).toHaveLength(1)
  })

  it('checks a pulling source against its system, seals its credential and queues a first read', async () => {
    const { deps, sources, paola, project, jobs } = await setup()
    const { source, ingestToken } = await createSource(deps, paola, project.slug, {
      kind: 'jira',
      name: 'Jira',
      config: { site: 'contoso' },
      secret: 'token-ok',
      scope: ['BOR'],
    })
    expect(ingestToken).toBeNull()
    expect(source).toMatchObject({ config: { site: 'contoso' }, perimeter: ['project:BOR'] })
    const stored = sources.rows.get(source.id)
    expect(new TextDecoder().decode(stored?.secret?.ciphertext)).toBe(`${source.id}:token-ok`)
    expect(jobs()).toEqual(['source.sync'])
  })

  it('refuses what cannot work, with the reason', async () => {
    const { deps, paola, marco, olga, project } = await setup()
    const create = (viewer: User, input: Parameters<typeof createSource>[3]) =>
      createSource(deps, viewer, project.slug, input)
    await expect(create(paola, { kind: 'ftp', name: 'x' })).rejects.toMatchObject({
      reason: 'invalid_kind',
    })
    await expect(create(paola, { kind: 'jira', name: 'x', secret: ' ' })).rejects.toBeInstanceOf(
      InvalidSourceError,
    )
    const refused = await create(paola, { kind: 'ado', name: 'x', secret: 'wrong' }).catch((e) => e)
    expect(refused).toMatchObject({ code: 'invalid', cause: { code: 'source_auth_failed' } })
    expect(await code(create(marco, { kind: 'files', name: 'x' }))).toBe('forbidden')
    expect(await code(create(olga, { kind: 'files', name: 'x' }))).toBe('not_found')
    await create(paola, { kind: 'files', name: 'Cartella' })
    expect(await code(create(paola, { kind: 'files', name: 'Cartella' }))).toBe('conflict')
  })

  it('rotates a token, reads on request and disconnects, each where it makes sense', async () => {
    const { deps, sources, paola, marco, project, jobs } = await setup()
    const files = await createSource(deps, paola, project.slug, { kind: 'files', name: 'Cartella' })
    const jira = await createSource(deps, paola, project.slug, {
      kind: 'jira',
      name: 'Jira',
      secret: 'token-ok',
    })
    const before = sources.rows.get(files.source.id)?.tokenHash
    const fresh = await rotateIngestToken(deps, paola, project.slug, files.source.id)
    expect(fresh).not.toBe(files.ingestToken)
    expect(sources.rows.get(files.source.id)?.tokenHash).not.toBe(before)
    expect(await code(rotateIngestToken(deps, paola, project.slug, jira.source.id))).toBe(
      'conflict',
    )
    expect(await code(requestSync(deps, paola, project.slug, files.source.id))).toBe('conflict')
    await requestSync(deps, paola, project.slug, jira.source.id)
    expect(jobs()).toEqual(['source.sync', 'source.sync'])
    expect(await code(deleteSource(deps, marco, project.slug, jira.source.id))).toBe('forbidden')
    expect(await code(deleteSource(deps, paola, project.slug, crypto.randomUUID()))).toBe(
      'not_found',
    )
    await deleteSource(deps, paola, project.slug, jira.source.id)
    expect(await listSources(deps, paola, project.slug)).toHaveLength(1)
  })
})

describe('a delivery of a feeder', () => {
  async function fed() {
    const context = await setup()
    const { source, ingestToken } = await createSource(
      context.deps,
      context.paola,
      context.project.slug,
      {
        kind: 'm365',
        name: 'Posta',
      },
    )
    const send = (payload: Delivery, token = ingestToken as string) =>
      ingestDelivery(context.store, source.id, token, payload)
    return { ...context, source, send }
  }

  it('stores documents as the person who connected the source and queues their processing', async () => {
    const { send, sources, documents, source, paola, project, deps, jobs } = await fed()
    const outcome = await send(delivery({ documents: [mail('m-1', 'v1', 'Budget: 100 euro')] }))
    expect(outcome).toMatchObject({ created: 1, updated: 0, unchanged: 0, duplicates: 0 })
    const [stored] = [...documents.rows.values()]
    expect(stored?.summary).toMatchObject({
      fileName: 'Mail m-1.md',
      uploadedBy: paola.id,
      sourceName: 'Posta',
      originAt: new Date('2026-11-10T08:00:00Z'),
    })
    expect(jobs()).toEqual(['document.process'])
    expect(sources.people).toEqual([
      { displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true },
    ])
    const [listed] = await listSources(deps, paola, project.slug)
    expect(listed).toMatchObject({
      id: source.id,
      documentCount: 1,
      dataAsOf: new Date('2026-11-12T08:00:00Z'),
      lastError: null,
    })
  })

  it('stores an item again only when its version changes, and replaces the old document', async () => {
    const { send, documents, blobs } = await fed()
    await send(delivery({ documents: [mail('m-1', 'v1', 'prima versione')] }))
    expect(
      await send(delivery({ documents: [mail('m-1', 'v1', 'prima versione')] })),
    ).toMatchObject({
      unchanged: 1,
      created: 0,
    })
    expect(
      await send(delivery({ documents: [mail('m-1', 'v2', 'seconda versione')] })),
    ).toMatchObject({
      updated: 1,
    })
    expect(documents.rows.size).toBe(1)
    expect(blobs.blobs.size).toBe(1)
    // The same bytes under another id: the project already has them.
    expect(
      await send(delivery({ documents: [mail('m-2', 'v1', 'seconda versione')] })),
    ).toMatchObject({
      duplicates: 1,
    })
  })

  it('keeps records and rows as data and marks what the source says is gone', async () => {
    const { send, sources, source } = await fed()
    const record = {
      externalId: 'BOR-1',
      version: '3',
      title: 'Storia BOR-1',
      record: { status: 'Done' },
      originAt: null,
      url: null,
      people: [],
    }
    const rows = {
      view: 'economics',
      perimeter: 'prj:PRJ000001',
      rows: [{ key: 'r1', values: { amount: 10 } }],
      extractedAt: new Date('2026-11-12T08:00:00Z'),
      sourceSyncedAt: null,
    }
    await send(delivery({ records: [record], rows: [rows] }))
    const outcome = await send(delivery({ removed: ['BOR-1'], dataAsOf: null }))
    expect(outcome).toMatchObject({ removed: 1, records: 0 })
    expect(sources.records.get(`${source.id}|BOR-1`)).toMatchObject({ removed: true })
    expect(sources.systemRows).toEqual([rows])
    // A delivery that says nothing about freshness keeps the one known.
    expect(sources.rows.get(source.id)?.source.dataAsOf).toEqual(new Date('2026-11-12T08:00:00Z'))
  })

  it('refuses a wrong token, an unknown source and a delivery over the limits', async () => {
    const { send, store } = await fed()
    expect(await code(send(delivery(), 'obf_wrong'))).toBe('unauthenticated')
    expect(await code(ingestDelivery(store, crypto.randomUUID(), 'obf_x', delivery()))).toBe(
      'unauthenticated',
    )
    const many = Array.from({ length: 101 }, (_, i) => mail(`m-${i}`, 'v1', `testo ${i}`))
    expect(await code(send(delivery({ documents: many })))).toBe('invalid')
    expect(await code(send(delivery({ documents: [mail('m-1', 'v1', '')] })))).toBe('invalid')
  })
})

describe('reading a pulling source', () => {
  async function connected() {
    const context = await setup()
    const { source } = await createSource(context.deps, context.paola, context.project.slug, {
      kind: 'jira',
      name: 'Jira',
      secret: 'token-ok',
    })
    return { ...context, source }
  }

  it('reads batch after batch with the unsealed credential and saves where it stopped', async () => {
    const { sync, feeds, sources, documents, logger, source } = await connected()
    feeds.batches = [
      {
        ...delivery({ documents: [mail('exp', 'v1', 'export')] }),
        nextCursor: { page: 1 },
        done: false,
      },
      { ...delivery(), nextCursor: { page: 2 }, done: true },
    ]
    await sync({ sourceId: source.id })
    expect(feeds.pulls).toEqual([
      { secret: 'token-ok', cursor: null },
      { secret: 'token-ok', cursor: { page: 1 } },
    ])
    expect(sources.rows.get(source.id)?.cursor).toEqual({ page: 2 })
    expect(documents.rows.size).toBe(1)
    expect(logger.entries.at(-1)).toMatchObject({
      message: 'source synced',
      fields: { created: 1 },
    })
  })

  it('records the code of a failure on the source and does not raise', async () => {
    const { sync, sources, source, logger } = await connected()
    await sync({ sourceId: source.id })
    expect(sources.rows.get(source.id)?.source.lastError).toBe('source_unavailable')
    expect(logger.entries.at(-1)).toMatchObject({ level: 'error', message: 'source sync failed' })

    const row = sources.rows.get(source.id)
    if (row) row.secret = new FakeVault().seal('another-source', 'x')
    await sync({ sourceId: source.id })
    expect(sources.rows.get(source.id)?.source.lastError).toBe('sync_failed')
    await sync({ sourceId: crypto.randomUUID() })
  })

  it('queues a read of every pulling source on schedule', async () => {
    const { deps, paola, project, sources, jobs, source } = await connected()
    await createSource(deps, paola, project.slug, { kind: 'files', name: 'Cartella' })
    const queue = new InMemoryJobQueue()
    await createScheduleSyncHandler({ sync: sources, jobs: queue })()
    expect([...queue.jobs.values()]).toEqual([
      { name: 'source.sync', data: { sourceId: source.id }, status: 'queued' },
    ])
    expect(jobs()).toEqual(['source.sync'])
  })
})
