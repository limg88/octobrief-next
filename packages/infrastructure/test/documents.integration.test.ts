import { randomUUID } from 'node:crypto'
import type { NewDocument } from '@octobrief/application'
import type { Classification, Extraction, User } from '@octobrief/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDocumentProcessingStore,
  createDocumentRepository,
} from '../src/postgres/document-repository.ts'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)

const extraction: Extraction = {
  extractor: 'test/1',
  chunks: [
    { locator: { kind: 'line', from: 1, to: 1 }, text: 'Stato avanzamento lavori' },
    { locator: { kind: 'page', page: 2 }, text: 'Avanzamento: 60%' },
  ],
  truncated: false,
  metadataDate: null,
  warnings: [],
}

const classification: Classification = {
  kind: 'status_report',
  audience: 'internal',
  audienceSource: 'default',
  dateOf: { date: new Date('2026-11-04T23:00:00Z'), source: 'file_name' },
  uncertain: ['audience'],
}

describe.skipIf(!hasDatabase)('documents on Postgres with row-level security (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const workerPool = createPool(DATABASE_WORKER_URL as string, 'octobrief-test-worker', 2)
  const users = createUserRepository(pool)
  const projects = createProjectRepository(pool)
  const documents = createDocumentRepository(pool)
  const store = createDocumentProcessingStore(workerPool)
  const run = randomUUID().slice(0, 8)
  let owner: User
  let outsider: User
  let admin: User
  let projectId: string

  const person = (tag: string, promote = false) =>
    users.upsertFromLogin(
      {
        externalSubject: `https://issuer.test|doc-${tag}-${run}`,
        displayName: `Person ${tag}`,
        email: `doc-${tag}-${run}@example.test`,
        emailVerified: true,
      },
      promote,
    )

  const newDocument = (content: string, uploadedBy = owner.id): NewDocument => {
    const sha256 = content.repeat(64).slice(0, 64)
    return {
      projectId,
      fileName: `SAL-${content}.md`,
      mediaType: 'text/markdown',
      sizeBytes: 42,
      sha256,
      blobKey: `${projectId}/${sha256}`,
      uploadedBy,
    }
  }

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
    owner = await person('owner')
    outsider = await person('outsider')
    admin = await person('admin', true)
    const project = await projects.create({
      slug: `doc-${run}`,
      name: `Documents ${run}`,
      client: null,
      ownerId: owner.id,
    })
    projectId = project.id
  })

  afterAll(async () => {
    await pool.end()
    await workerPool.end()
  })

  it('creates a document once per content and shows it to members and admins only', async () => {
    const created = await documents.create(owner.id, newDocument('a'))
    expect(created).toMatchObject({
      status: 'pending',
      fileName: 'SAL-a.md',
      sizeBytes: 42,
      uploaderName: 'Person owner',
      uncertain: [],
    })
    expect(await documents.create(owner.id, newDocument('a'))).toBeNull()
    expect(await documents.list(owner.id, projectId)).toHaveLength(1)
    expect(await documents.list(admin.id, projectId)).toHaveLength(1)
    expect(await documents.list(outsider.id, projectId)).toEqual([])
    expect(await documents.find(outsider.id, projectId, created?.id as string)).toBeNull()
  })

  it('refuses inserts into projects the viewer cannot see', async () => {
    await expect(
      documents.create(outsider.id, newDocument('b', outsider.id)),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('lets the worker process a pending document and keeps text behind the policy', async () => {
    const created = await documents.create(owner.id, newDocument('c'))
    const id = created?.id as string
    const pending = await store.pending(id)
    expect(pending).toMatchObject({
      id,
      fileName: 'SAL-c.md',
      blobKey: `${projectId}/${'c'.repeat(64)}`,
    })

    await store.markReady(id, extraction, classification)
    await store.markReady(id, extraction, classification)
    expect(await store.pending(id)).toBeNull()

    const ready = await documents.find(owner.id, projectId, id)
    expect(ready).toMatchObject({
      status: 'ready',
      kind: 'status_report',
      audience: 'internal',
      dateSource: 'file_name',
      uncertain: ['audience'],
      chunkCount: 2,
    })
    expect(await documents.chunks(owner.id, id, 10)).toEqual(extraction.chunks)
    expect(await documents.chunks(owner.id, id, 1)).toHaveLength(1)
    expect(await documents.chunks(outsider.id, id, 10)).toEqual([])
  })

  it('saves the PM classification and records failures', async () => {
    const created = await documents.create(owner.id, newDocument('d'))
    const id = created?.id as string
    await store.markReady(id, extraction, classification)
    const updated = await documents.saveClassification(owner.id, id, {
      kind: 'contract',
      audience: 'client',
      audienceSource: 'pm',
      uncertain: [],
    })
    expect(updated).toMatchObject({ kind: 'contract', audience: 'client', audienceSource: 'pm' })

    const broken = await documents.create(owner.id, newDocument('e'))
    await store.markFailed(broken?.id as string, {
      ...extraction,
      chunks: [],
      warnings: ['encrypted'],
    })
    expect(await documents.find(owner.id, projectId, broken?.id as string)).toMatchObject({
      status: 'failed',
      warnings: ['encrypted'],
    })
  })

  it('removes documents with their text, for viewers and for retention', async () => {
    const created = await documents.create(owner.id, newDocument('f'))
    const id = created?.id as string
    await store.markReady(id, extraction, classification)
    expect(await documents.remove(outsider.id, id)).toBeNull()
    expect(await documents.remove(owner.id, id)).toBe(`${projectId}/${'f'.repeat(64)}`)
    expect(await documents.find(owner.id, projectId, id)).toBeNull()

    const old = await documents.create(owner.id, newDocument('9'))
    const expired = await store.expired(new Date(Date.now() + 60_000), 1_000)
    expect(expired.map((document) => document.id)).toContain(old?.id)
    await store.removeExpired(old?.id as string)
    expect(await documents.find(owner.id, projectId, old?.id as string)).toBeNull()
  })
})
