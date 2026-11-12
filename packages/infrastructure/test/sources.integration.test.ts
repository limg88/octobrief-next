import { randomBytes, randomUUID } from 'node:crypto'
import type { NewSource, SourceTarget } from '@octobrief/application'
import type { ExternalDocument, User } from '@octobrief/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDocumentProcessingStore,
  createDocumentRepository,
} from '../src/postgres/document-repository.ts'
import { createKnowledgeStore } from '../src/postgres/knowledge-store.ts'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import {
  createExternalItemStore,
  createSourceRepository,
  createSourceSyncStore,
} from '../src/postgres/source-repository.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'
import { createSecretVault, readSecretsKey } from '../src/secrets/vault.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)
const TOKEN_HASH = 'a'.repeat(64)

describe.skipIf(!hasDatabase)('sources on Postgres (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const workerPool = createPool(DATABASE_WORKER_URL as string, 'octobrief-test-worker', 2)
  const users = createUserRepository(pool)
  const projects = createProjectRepository(pool)
  const documents = createDocumentRepository(pool)
  const sources = createSourceRepository(pool)
  const sync = createSourceSyncStore(workerPool)
  const fed = createExternalItemStore(pool, { asCreator: true })
  const pulled = createExternalItemStore(workerPool, { asCreator: false })
  const vault = createSecretVault(
    readSecretsKey(randomBytes(32).toString('base64')) as NonNullable<
      ReturnType<typeof readSecretsKey>
    >,
  )
  const run = randomUUID().slice(0, 8)
  let owner: User
  let outsider: User
  let projectId: string

  const person = (tag: string) =>
    users.upsertFromLogin(
      {
        externalSubject: `https://issuer.test|src-${tag}-${run}`,
        displayName: `Person ${tag}`,
        email: `src-${tag}-${run}@example.test`,
        emailVerified: true,
      },
      false,
    )

  const newSource = (over: Partial<NewSource>): NewSource => ({
    id: randomUUID(),
    projectId,
    kind: 'm365',
    name: `Posta ${randomUUID().slice(0, 6)}`,
    config: {},
    perimeter: [],
    tokenHash: null,
    secret: null,
    folderPath: null,
    createdBy: owner.id,
    ...over,
  })

  const item = (externalId: string, version: string, text: string): ExternalDocument => ({
    externalId,
    version,
    title: `Mail ${externalId}`,
    mediaType: 'text/markdown',
    bytes: new TextEncoder().encode(text),
    originAt: new Date('2026-11-10T08:00:00Z'),
    url: 'https://example.test/mail/1',
    systemKind: 'email',
    people: [],
  })

  const stored = (target: SourceTarget, doc: ExternalDocument, store = fed) => {
    const sha256 = randomUUID().replaceAll('-', '').repeat(2)
    return store.createDocument(target, {
      item: doc,
      fileName: `${doc.title}.md`,
      sha256,
      blobKey: `${projectId}/${sha256}`,
    })
  }

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
    owner = await person('owner')
    outsider = await person('outsider')
    const project = await projects.create({
      slug: `src-${run}`,
      name: `Sources ${run}`,
      client: null,
      ownerId: owner.id,
    })
    projectId = project.id
  })

  afterAll(async () => {
    await pool.end()
    await workerPool.end()
  })

  it('creates a source once per name and shows it to members only', async () => {
    const source = newSource({ name: 'Posta Borea', tokenHash: TOKEN_HASH })
    expect(await sources.create(owner.id, source)).toMatchObject({
      id: source.id,
      kind: 'm365',
      feed: 'push',
      folderPath: null,
      name: 'Posta Borea',
      documentCount: 0,
      lastSyncAt: null,
    })
    expect(await sources.create(owner.id, newSource({ name: 'Posta Borea' }))).toBeNull()
    expect(await sources.list(owner.id, projectId)).toHaveLength(1)
    expect(await sources.list(outsider.id, projectId)).toEqual([])
    expect(await sources.find(outsider.id, projectId, source.id)).toBeNull()
    await expect(
      sources.create(outsider.id, newSource({ createdBy: outsider.id })),
    ).rejects.toThrow(/row-level security/)
  })

  it('finds the source of a token without a session, and nothing for a wrong one', async () => {
    const [source] = await sources.list(owner.id, projectId)
    const id = source?.id as string
    expect(await sources.ingestTarget(id, TOKEN_HASH)).toEqual({
      id,
      projectId,
      kind: 'm365',
      createdBy: owner.id,
    })
    expect(await sources.ingestTarget(id, 'b'.repeat(64))).toBeNull()
    await sources.setTokenHash(owner.id, id, 'c'.repeat(64))
    expect(await sources.ingestTarget(id, TOKEN_HASH)).toBeNull()
    expect(await sources.ingestTarget(id, 'c'.repeat(64))).not.toBeNull()
  })

  it('stores what a feeder brings as the person who connected the source', async () => {
    const [source] = await sources.list(owner.id, projectId)
    const target = (await sources.ingestTarget(
      source?.id as string,
      'c'.repeat(64),
    )) as SourceTarget
    const documentId = (await stored(target, item('m-1', 'v1', 'testo'))) as string
    expect(await fed.document(target, 'm-1')).toMatchObject({ documentId, version: 'v1' })
    expect(await fed.document(target, 'm-9')).toBeNull()

    const [summary] = await documents.list(owner.id, projectId)
    expect(summary).toMatchObject({
      fileName: 'Mail m-1.md',
      uploadedBy: owner.id,
      sourceName: 'Posta Borea',
      originAt: new Date('2026-11-10T08:00:00Z'),
    })
    const pending = await createDocumentProcessingStore(workerPool).pending(documentId)
    expect(pending).toMatchObject({
      systemKind: 'email',
      originAt: new Date('2026-11-10T08:00:00Z'),
    })

    await fed.savePeople(target, [
      { displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true },
      { displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true },
      { displayName: 'Mario Rossi' },
    ])
    // Seen again from inside the organization: trusted from now on.
    await fed.savePeople(target, [{ displayName: 'Carla Cliente', email: 'carla@cliente.example' }])
    expect(await createKnowledgeStore(workerPool).people(projectId)).toEqual([
      { displayName: 'Person owner', email: `src-owner-${run}@example.test` },
      { displayName: 'Carla Cliente', email: 'carla@cliente.example', trust: 'seen' },
      { displayName: 'Mario Rossi', trust: 'seen' },
    ])

    // Speakers a document names are remembered too, as names chosen outside the organization.
    await createDocumentProcessingStore(workerPool).rememberPeople(documentId, [
      'Luca Inventato',
      'Mario Rossi',
      'Carla Cliente',
    ])
    // Carla is already known with her email: the document does not add her a second time.
    const people = await createKnowledgeStore(workerPool).people(projectId)
    expect(people.filter((person) => person.displayName === 'Carla Cliente')).toHaveLength(1)
    expect(await createKnowledgeStore(workerPool).people(projectId)).toContainEqual({
      displayName: 'Luca Inventato',
      trust: 'untrusted',
    })
    // The other way round: Luca, first read in a document, later arrives from a feed with an email.
    await fed.savePeople(target, [
      { displayName: 'Luca Inventato', email: 'luca@cliente.example', untrusted: true },
    ])
    const after = await createKnowledgeStore(workerPool).people(projectId)
    expect(after.filter((person) => person.displayName === 'Luca Inventato')).toEqual([
      { displayName: 'Luca Inventato', email: 'luca@cliente.example', trust: 'untrusted' },
    ])
    await fed.delivered(target, new Date('2026-11-12T08:00:00Z'), null)
    await fed.delivered(target, null, 'source_unavailable')
    expect((await sources.list(owner.id, projectId))[0]).toMatchObject({
      documentCount: 1,
      dataAsOf: new Date('2026-11-12T08:00:00Z'),
      lastError: 'source_unavailable',
    })

    expect(await fed.removeDocument(target, documentId)).toMatch(new RegExp(`^${projectId}/`))
    expect(await fed.removeDocument(target, documentId)).toBeNull()
  })

  it('refuses a delivery when the person who connected the source no longer sees the project', async () => {
    const ghost: SourceTarget = {
      id: randomUUID(),
      projectId,
      kind: 'm365',
      createdBy: outsider.id,
    }
    await expect(stored(ghost, item('m-2', 'v1', 'x'))).rejects.toThrow(/row-level security/)
  })

  it('lets the worker read a pulling source: sealed credential, cursor, records and rows', async () => {
    const source = newSource({ kind: 'jira', name: 'Jira', config: { site: 'contoso' } })
    const withSecret = { ...source, perimeter: ['project:1'], secret: vault.seal(source.id, 'pat') }
    await sources.create(owner.id, withSecret)
    expect(await sync.pullSourceIds()).toContain(source.id)

    // A source read from a synchronized folder is the worker's too, whatever its kind; one fed
    // with a token is not, even when it is a tracker.
    const fromFolder = newSource({ name: 'Posta da cartella', folderPath: '/sync/borea' })
    expect(await sources.create(owner.id, fromFolder)).toMatchObject({
      feed: 'folder',
      folderPath: '/sync/borea',
    })
    const pushed = newSource({ kind: 'ado', name: 'ADO dal PC', tokenHash: TOKEN_HASH })
    expect(await sources.create(owner.id, pushed)).toMatchObject({ kind: 'ado', feed: 'push' })
    const worked = await sync.pullSourceIds()
    expect(worked).toContain(fromFolder.id)
    expect(worked).not.toContain(pushed.id)
    expect(await sync.load(fromFolder.id)).toMatchObject({
      kind: 'm365',
      folderPath: '/sync/borea',
    })
    expect(await sync.load(pushed.id)).toBeNull()
    // One way in for each source.
    await expect(
      sources.create(owner.id, newSource({ name: 'Due', folderPath: '/x', tokenHash: TOKEN_HASH })),
    ).rejects.toThrow(/sources_one_feed/)

    const loaded = await sync.load(source.id)
    expect(loaded).toMatchObject({
      kind: 'jira',
      folderPath: null,
      config: { site: 'contoso' },
      perimeter: ['project:1'],
      cursor: null,
      createdBy: owner.id,
    })
    expect(
      vault.unseal(source.id, loaded?.secret as NonNullable<typeof loaded>['secret'] & object),
    ).toBe('pat')
    await sync.saveCursor(source.id, { updated: '2026-11-12', ids: ['1'] })
    expect((await sync.load(source.id))?.cursor).toEqual({ updated: '2026-11-12', ids: ['1'] })
    expect(await sync.load(randomUUID())).toBeNull()

    const target = loaded as SourceTarget
    expect(await stored(target, item('export', 'v1', 'backlog'), pulled)).toEqual(
      expect.any(String),
    )
    const record = {
      externalId: 'BOR-1',
      version: '1',
      title: 'Storia',
      record: { status: 'To Do' },
      originAt: null,
      url: null,
      people: [],
    }
    await pulled.saveRecords(target, [record])
    await pulled.saveRecords(target, [{ ...record, version: '2', record: { status: 'Done' } }])
    await pulled.markRemoved(target, ['BOR-1'])
    await pulled.saveRows(target, {
      view: 'economics',
      perimeter: 'prj:PRJ000001',
      rows: [{ key: 'r1', values: { amount: 10 } }],
      extractedAt: new Date('2026-11-12T08:00:00Z'),
      sourceSyncedAt: null,
    })
    const { rows } = await workerPool.query(
      `SELECT t.version, t.record, t.removed_at IS NOT NULL AS removed, r."values"
         FROM tracker_items t JOIN system_rows r ON r.source_id = t.source_id
        WHERE t.source_id = $1`,
      [source.id],
    )
    expect(rows).toEqual([
      { version: '2', record: { status: 'Done' }, removed: true, values: { amount: 10 } },
    ])

    // Disconnecting keeps the documents, no longer tied to a source.
    await sources.remove(owner.id, source.id)
    const kept = (await documents.list(owner.id, projectId)).find(
      (d) => d.fileName === 'Mail export.md',
    )
    expect(kept).toMatchObject({ sourceName: null })
  })
})
