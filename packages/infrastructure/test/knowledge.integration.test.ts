import { randomUUID } from 'node:crypto'
import type { KnowledgeChange } from '@octobrief/application'
import {
  type Classification,
  type EvidenceId,
  type Extraction,
  type Fact,
  type FactId,
  newId,
  type ProjectId,
  type User,
} from '@octobrief/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeEmbedding } from '../src/model/fake-runner.ts'
import {
  createDocumentProcessingStore,
  createDocumentRepository,
} from '../src/postgres/document-repository.ts'
import { createFactRepository, createKnowledgeStore } from '../src/postgres/knowledge-store.ts'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)

const extraction: Extraction = {
  extractor: 'test/1',
  chunks: [
    { locator: { kind: 'line', from: 1, to: 1 }, text: 'Budget: 120.000 euro' },
    { locator: { kind: 'page', page: 2 }, text: 'Rischio di ritardo del fornitore' },
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

describe.skipIf(!hasDatabase)('knowledge on Postgres (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const workerPool = createPool(DATABASE_WORKER_URL as string, 'octobrief-test-worker', 2)
  const users = createUserRepository(pool)
  const projects = createProjectRepository(pool)
  const documents = createDocumentRepository(pool)
  const processing = createDocumentProcessingStore(workerPool)
  const knowledge = createKnowledgeStore(workerPool)
  const facts = createFactRepository(pool)
  const run = randomUUID().slice(0, 8)
  let owner: User
  let outsider: User
  let projectId: string

  const person = (tag: string) =>
    users.upsertFromLogin(
      {
        externalSubject: `https://issuer.test|kn-${tag}-${run}`,
        displayName: `Person ${tag}`,
        email: `kn-${tag}-${run}@example.test`,
        emailVerified: true,
      },
      false,
    )

  async function readyDocument(tag: string): Promise<string> {
    const sha256 = randomUUID().replaceAll('-', '').repeat(2)
    const created = await documents.create(owner.id, {
      projectId,
      fileName: `SAL-${tag}.md`,
      mediaType: 'text/markdown',
      sizeBytes: 42,
      sha256,
      blobKey: `${projectId}/${sha256}`,
      uploadedBy: owner.id,
    })
    const id = created?.id as string
    await processing.markReady(id, extraction, classification)
    return id
  }

  const fact = (documentId: string, value: string, over: Partial<Fact> = {}): Fact => ({
    id: newId<FactId>(),
    projectId: projectId as ProjectId,
    kind: 'economics',
    key: 'economics:budget',
    statement: `Il budget è ${value}.`,
    value,
    sources: [
      {
        evidenceId: documentId as EvidenceId,
        locator: { kind: 'line', from: 1, to: 1 },
        excerpt: 'Budget: 120.000 euro',
      },
    ],
    origin: 'compile',
    state: 'active',
    lockedByPm: false,
    pmAsserted: false,
    createdAt: new Date('2026-11-12T09:00:00Z'),
    ...over,
  })

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
    owner = await person('owner')
    outsider = await person('outsider')
    const project = await projects.create({
      slug: `kn-${run}`,
      name: `Knowledge ${run}`,
      client: 'ACME Costruzioni',
      ownerId: owner.id,
    })
    projectId = project.id
  })

  afterAll(async () => {
    await pool.end()
    await workerPool.end()
  })

  it('hands a classified document to the compile once, with its text and people', async () => {
    const id = await readyDocument('a')
    const document = await knowledge.compilable(id)
    expect(document).toMatchObject({
      id,
      projectId,
      fileName: 'SAL-a.md',
      uploadedBy: owner.id,
      classification: { ...classification, dateOf: classification.dateOf },
      chunks: extraction.chunks,
    })
    expect(await knowledge.people(projectId)).toEqual([
      { displayName: 'Person owner', email: `kn-owner-${run}@example.test` },
      { displayName: 'ACME Costruzioni', kind: 'organization' },
    ])
    expect(await facts.progress(owner.id, projectId)).toEqual({
      reading: 1,
      failed: 0,
      compiled: 0,
    })

    await knowledge.markKnowledgeFailed(id, 'model_unavailable')
    expect(await facts.progress(owner.id, projectId)).toEqual({
      reading: 0,
      failed: 1,
      compiled: 0,
    })
    expect(await knowledge.compilable(id)).not.toBeNull()

    await knowledge.saveKnowledge(id, [{ kind: 'insert', fact: fact(id, '120.000 euro') }], false)
    expect(await knowledge.compilable(id)).toBeNull()
    expect(await knowledge.compilable(randomUUID())).toBeNull()
    expect(await facts.progress(owner.id, projectId)).toEqual({
      reading: 0,
      failed: 0,
      compiled: 1,
    })
  })

  it('shows facts with their sources to members only', async () => {
    const listed = await facts.list(owner.id, projectId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      kind: 'economics',
      value: '120.000 euro',
      state: 'active',
      sources: [
        {
          fileName: 'SAL-a.md',
          locator: { kind: 'line', from: 1, to: 1 },
          excerpt: 'Budget: 120.000 euro',
        },
      ],
    })
    expect(await facts.list(outsider.id, projectId)).toEqual([])
    expect(await facts.progress(outsider.id, projectId)).toEqual({
      reading: 0,
      failed: 0,
      compiled: 0,
    })
    await expect(
      pool.query(
        'INSERT INTO facts (id, project_id, kind, key, statement) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), projectId, 'note', 'note:x', 'x'],
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('adds sources, contests, replaces, and drops what a deleted document alone stated', async () => {
    const [first] = await knowledge.facts(projectId)
    const original = first as Fact
    const second = await readyDocument('b')
    const third = await readyDocument('c')
    const rival = fact(second, '135.000 euro', {
      state: 'contested',
      createdAt: new Date('2026-11-12T10:00:00Z'),
    })
    const page = { kind: 'page' as const, page: 2 }
    const changes: KnowledgeChange[] = [
      {
        kind: 'add_sources',
        factId: original.id,
        sources: [{ evidenceId: third as EvidenceId, locator: page, excerpt: 'Budget: 120.000' }],
      },
      { kind: 'contest', factId: original.id, fact: rival },
    ]
    await knowledge.saveKnowledge(second, changes, false)
    let stored = await knowledge.facts(projectId)
    expect(stored.map((f) => [f.value, f.state, f.sources.length])).toEqual([
      ['120.000 euro', 'contested', 2],
      ['135.000 euro', 'contested', 1],
    ])

    await knowledge.saveKnowledge(
      third,
      [
        {
          kind: 'replace',
          factId: rival.id,
          proposed: {
            kind: 'economics',
            key: rival.key,
            statement: 'Il budget è 140.000 euro.',
            value: '140.000 euro',
            sources: [
              { evidenceId: third as EvidenceId, locator: page, excerpt: 'Budget: 140.000' },
            ],
          },
        },
      ],
      false,
    )
    stored = await knowledge.facts(projectId)
    expect(stored[1]).toMatchObject({
      value: '140.000 euro',
      state: 'active',
      sources: [{ evidenceId: third, excerpt: 'Budget: 140.000' }],
    })

    // The third document goes: the fact it alone stated goes with it, the other keeps one source.
    await documents.remove(owner.id, third)
    stored = await knowledge.facts(projectId)
    expect(stored.map((f) => [f.value, f.state, f.sources.length])).toEqual([
      ['120.000 euro', 'active', 1],
    ])
  })

  it('stores one vector per chunk with its encoder', async () => {
    const id = await readyDocument('d')
    await knowledge.saveEmbeddings(id, { model: 'fake-embedding', digest: 'v1' }, [
      fakeEmbedding('budget'),
      fakeEmbedding('rischio fornitore'),
    ])
    const { rows } = await workerPool.query<{ encoder: string; dims: number; near: number }>(
      `SELECT encoder, vector_dims(embedding) AS dims,
              (embedding <=> $2::vector)::float8 AS near
         FROM document_chunks WHERE document_id = $1 ORDER BY position`,
      [id, `[${fakeEmbedding('rischio fornitore').join(',')}]`],
    )
    expect(rows.map((row) => [row.encoder, row.dims])).toEqual([
      ['fake-embedding@v1', 1024],
      ['fake-embedding@v1', 1024],
    ])
    expect(rows[1]?.near).toBeCloseTo(0)
    expect(rows[0]?.near).toBeGreaterThan(0.5)
  })
})
