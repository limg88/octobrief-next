import { randomUUID } from 'node:crypto'
import {
  type Classification,
  type EvidenceId,
  type Extraction,
  type Fact,
  type FactId,
  newId,
  type ProjectId,
  type SourceId,
  type User,
  type VerifiedAnswer,
} from '@octobrief/domain'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeEmbedding } from '../src/model/fake-runner.ts'
import { answerStore, knowledgeReader, trackerReader } from '../src/postgres/ask-store.ts'
import {
  createDocumentProcessingStore,
  createDocumentRepository,
} from '../src/postgres/document-repository.ts'
import { createKnowledgeStore } from '../src/postgres/knowledge-store.ts'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import {
  createQuestionRepository,
  createQuestionWorkStore,
} from '../src/postgres/question-store.ts'
import {
  createExternalItemStore,
  createSourceRepository,
} from '../src/postgres/source-repository.ts'
import { inTransaction } from '../src/postgres/transaction.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)
const ENCODER = { model: 'fake-embedding', digest: 'v1' }

const text = (lines: string[]): Extraction => ({
  extractor: 'test/1',
  chunks: lines.map((line, i) => ({
    locator: { kind: 'line', from: i + 1, to: i + 1 },
    text: line,
  })),
  truncated: false,
  metadataDate: null,
  warnings: [],
})

const classified = (kind: Classification['kind'], date: string): Classification => ({
  kind,
  audience: 'internal',
  audienceSource: 'default',
  dateOf: { date: new Date(date), source: 'file_name' },
  uncertain: [],
})

describe.skipIf(!hasDatabase)('asking on Postgres (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const workerPool = createPool(DATABASE_WORKER_URL as string, 'octobrief-test-worker', 2)
  const users = createUserRepository(pool)
  const projects = createProjectRepository(pool)
  const documents = createDocumentRepository(pool)
  const processing = createDocumentProcessingStore(workerPool)
  const knowledge = createKnowledgeStore(workerPool)
  const sources = createSourceRepository(pool)
  const items = createExternalItemStore(workerPool, { asCreator: false })
  const questions = createQuestionRepository(pool)
  const work = createQuestionWorkStore(workerPool)
  const run = randomUUID().slice(0, 8)
  const read = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => inTransaction(workerPool, fn)
  let owner: User
  let member: User
  let outsider: User
  let projectId: ProjectId
  let otherProjectId: ProjectId
  let oldSal: EvidenceId
  let newSal: EvidenceId
  let note: EvidenceId
  let budgetFact: Fact

  const person = (tag: string, name = `Person ${tag}`) =>
    users.upsertFromLogin(
      {
        externalSubject: `https://issuer.test|ask-${tag}-${run}`,
        displayName: name,
        email: `ask-${tag}-${run}@example.test`,
        emailVerified: true,
      },
      false,
    )

  async function ready(
    project: string,
    fileName: string,
    lines: string[],
    classification: Classification,
  ): Promise<EvidenceId> {
    const sha256 = randomUUID().replaceAll('-', '').repeat(2)
    const created = await documents.create(owner.id, {
      projectId: project,
      fileName,
      mediaType: 'text/markdown',
      sizeBytes: 42,
      sha256,
      blobKey: `${project}/${sha256}`,
      uploadedBy: owner.id,
    })
    const id = created?.id as string
    await processing.markReady(id, text(lines), classification)
    await knowledge.saveEmbeddings(id, ENCODER, lines.map(fakeEmbedding))
    return id as EvidenceId
  }

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
    owner = await person('owner', 'Paola Prova')
    member = await person('member')
    outsider = await person('outsider')
    const project = await projects.create({
      slug: `ask-${run}`,
      name: `Ask ${run}`,
      client: 'ACME Costruzioni',
      ownerId: owner.id,
    })
    projectId = project.id as ProjectId
    await projects.addMember(projectId, member.id, 'member')
    const other = await projects.create({
      slug: `ask-other-${run}`,
      name: `Other ${run}`,
      client: null,
      ownerId: owner.id,
    })
    otherProjectId = other.id as ProjectId

    oldSal = await ready(
      projectId,
      'SAL-2026-10-01.md',
      ['Budget complessivo: 890.000 euro.', 'Avanzamento dei lavori al 40%.'],
      classified('status_report', '2026-10-01T00:00:00Z'),
    )
    newSal = await ready(
      projectId,
      'SAL-2026-11-04.md',
      ['Budget complessivo: 950.000 euro.', 'Il collaudo è previsto a dicembre.'],
      classified('status_report', '2026-11-04T00:00:00Z'),
    )
    note = await ready(
      projectId,
      'Nota-fornitore.txt',
      ['Il fornitore segnala un ritardo nella consegna del modulo.'],
      classified('generic', '2026-11-05T00:00:00Z'),
    )
    await ready(
      otherProjectId,
      'Segreto.md',
      ['Budget complessivo riservato di un altro progetto: 1 euro.'],
      classified('status_report', '2026-11-06T00:00:00Z'),
    )
    budgetFact = {
      id: newId<FactId>(),
      projectId,
      kind: 'economics',
      key: 'economics:budget complessivo',
      statement: 'Il budget complessivo è di 950.000 euro.',
      value: '950.000 euro',
      sources: [
        {
          evidenceId: newSal,
          locator: { kind: 'line', from: 1, to: 1 },
          excerpt: 'Budget complessivo: 950.000 euro.',
        },
      ],
      origin: 'compile',
      state: 'contested',
      lockedByPm: false,
      pmAsserted: false,
      createdAt: new Date('2026-11-12T09:00:00Z'),
    }
    await knowledge.saveKnowledge(newSal, [{ kind: 'insert', fact: budgetFact }], true)
    await workerPool.query(`UPDATE facts SET state = 'contested' WHERE id = $1`, [budgetFact.id])
  })

  afterAll(async () => {
    await pool.end()
    await workerPool.end()
  })

  it('finds passages and facts by any word of the question, only in the project', async () => {
    const hits = await read((tx) =>
      knowledgeReader.search(tx, projectId, 'Qual è il budget complessivo?'),
    )
    expect(hits.map((hit) => hit.kind).sort()).toEqual(['chunk', 'chunk', 'fact'])
    expect(hits.every((hit) => hit.score > 0)).toBe(true)
    expect(JSON.stringify(hits)).not.toContain('riservato')
    const fact = hits.find((hit) => hit.kind === 'fact')
    expect(fact).toMatchObject({
      factId: budgetFact.id,
      title: 'economics:budget complessivo',
      snippet: 'Il budget complessivo è di 950.000 euro. (950.000 euro)',
      sourceDate: new Date('2026-11-04T00:00:00Z'),
    })
    const chunk = hits.find((hit) => hit.evidenceId === newSal)
    expect(chunk).toMatchObject({
      title: 'SAL-2026-11-04.md',
      locator: { kind: 'line', from: 1, to: 1 },
      suspicious: true,
    })
    expect(await read((tx) => knowledgeReader.search(tx, projectId, 'e il la'))).toEqual([])
  })

  it('adds what is close in meaning when the question comes with its vector', async () => {
    const vector = { vector: fakeEmbedding('ritardo consegna modulo fornitore'), ...ENCODER }
    const withMeaning = await read((tx) =>
      knowledgeReader.search(tx, projectId, 'slittamento', { embedding: vector }),
    )
    expect(withMeaning[0]).toMatchObject({ evidenceId: note })
    // Vectors of another encoder never compare.
    const stranger = { ...vector, digest: 'v2' }
    expect(
      await read((tx) =>
        knowledgeReader.search(tx, projectId, 'slittamento', { embedding: stranger }),
      ),
    ).toEqual([])
  })

  it('lists and reads documents and facts of the project only', async () => {
    const listed = await read((tx) => knowledgeReader.listSources(tx, projectId, 2))
    expect(listed.map((source) => source.title)).toEqual([
      'Nota-fornitore.txt',
      'SAL-2026-11-04.md',
    ])
    const page = { locator: null, offset: 1, limit: 5 }
    const evidence = await read((tx) => knowledgeReader.readEvidence(tx, projectId, newSal, page))
    expect(evidence).toMatchObject({
      title: 'SAL-2026-11-04.md',
      suspicious: true,
      chunks: [{ text: 'Il collaudo è previsto a dicembre.' }],
      more: false,
    })
    expect(
      await read((tx) => knowledgeReader.readEvidence(tx, otherProjectId, newSal, page)),
    ).toBeNull()
    const fact = await read((tx) => knowledgeReader.readFact(tx, projectId, budgetFact.id))
    expect(fact).toMatchObject({
      key: 'economics:budget complessivo',
      state: 'contested',
      date: new Date('2026-11-04T00:00:00Z'),
      dateSource: 'file_name',
      sources: [{ evidenceId: newSal }],
    })
    expect(
      await read((tx) => knowledgeReader.readFact(tx, otherProjectId, budgetFact.id)),
    ).toBeNull()
  })

  it('registers what an answer cites: title, date, and whether a newer version exists', async () => {
    const context = await read((tx) => answerStore.askContext(tx, projectId))
    expect(context?.knownNames).toEqual(expect.arrayContaining(['Paola Prova', 'Paola']))
    expect(context?.knownNames).not.toContain('ACME Costruzioni')
    expect(await read((tx) => answerStore.askContext(tx, randomUUID() as ProjectId))).toBeNull()

    const evidence = await read((tx) =>
      answerStore.registeredEvidence(tx, projectId, [oldSal, newSal, randomUUID() as EvidenceId]),
    )
    expect([...evidence.keys()].sort()).toEqual([oldSal, newSal].sort())
    expect(evidence.get(oldSal)).toMatchObject({ title: 'SAL-2026-10-01.md', superseded: true })
    expect(evidence.get(newSal)).toMatchObject({ freshnessPolicy: 'document', superseded: false })
    expect(
      (await read((tx) => answerStore.registeredEvidence(tx, otherProjectId, [newSal]))).size,
    ).toBe(0)

    const facts = await read((tx) => answerStore.registeredFacts(tx, projectId, [budgetFact.id]))
    expect(facts.get(budgetFact.id)).toMatchObject({
      title: 'SAL-2026-11-04.md',
      sourceDate: new Date('2026-11-04T00:00:00Z'),
      contested: true,
      pmAsserted: false,
      superseded: false,
    })
    expect((await read((tx) => answerStore.registeredFacts(tx, projectId, []))).size).toBe(0)
  })

  it('reads the items of the trackers of the project', async () => {
    const source = {
      id: randomUUID(),
      projectId,
      kind: 'jira' as const,
      name: 'Jira',
      config: {},
      perimeter: [],
      tokenHash: null,
      secret: null,
      folderPath: null,
      createdBy: owner.id,
    }
    await sources.create(owner.id, source)
    const target = { id: source.id, projectId, kind: source.kind, createdBy: owner.id }
    const record = {
      externalId: 'BOR-1',
      version: '1',
      title: 'Storia',
      record: { status: 'Done' },
      originAt: null,
      url: 'https://example.test/BOR-1',
      people: [],
    }
    await items.saveRecords(target, [record, { ...record, externalId: 'BOR-2' }])
    await items.markRemoved(target, ['BOR-2'])
    const [tracker] = await read((tx) => trackerReader.sources(tx, projectId))
    expect(tracker).toMatchObject({
      sourceId: source.id,
      kind: 'jira',
      label: 'Jira',
      pending: true,
    })
    await items.delivered(target, new Date('2026-11-12T08:00:00Z'), 'source_unavailable')
    expect((await read((tx) => trackerReader.sources(tx, projectId)))[0]).toMatchObject({
      pending: false,
      dataAsOf: new Date('2026-11-12T08:00:00Z'),
      lastErrorCode: 'source_unavailable',
    })
    const query = { sourceIds: [source.id as SourceId], at: null, limit: 10 }
    expect(await read((tx) => trackerReader.items(tx, projectId, query))).toEqual([
      {
        sourceId: source.id,
        kind: 'jira',
        externalId: 'BOR-1',
        fields: { title: 'Storia', status: 'Done' },
        url: 'https://example.test/BOR-1',
      },
    ])
    expect(
      await read((tx) => trackerReader.items(tx, projectId, { ...query, sourceIds: [] })),
    ).toEqual([])
    expect(await read((tx) => trackerReader.items(tx, otherProjectId, query))).toEqual([])
    expect(
      (await read((tx) => trackerReader.people(tx, projectId))).map((p) => p.displayName),
    ).toContain('ACME Costruzioni')
  })

  it('keeps questions private to who asked and stores the verified answer', async () => {
    const question = await questions.create(owner.id, { projectId, text: 'Budget?', lang: 'it' })
    expect(question).toMatchObject({ phase: 'queued', answer: null, askedBy: owner.id })
    expect(await questions.list(member.id, projectId, 10)).toEqual([])
    expect(await questions.find(member.id, projectId, question.id)).toBeNull()
    await expect(
      questions.create(outsider.id, { projectId, text: 'x', lang: 'it' }),
    ).rejects.toThrow(/row-level security/)

    expect(await work.pending(question.id)).toMatchObject({ text: 'Budget?', askedBy: owner.id })
    await work.setPhase(question.id, 'reading')
    expect((await questions.find(owner.id, projectId, question.id))?.phase).toBe('reading')
    const answer: VerifiedAnswer = {
      lang: 'it',
      segments: [],
      contradictions: [],
      absences: [],
      checks: { total: 2, anomalies: 0, list: [] },
    }
    await work.saveAnswer(question.id, answer, { turns: 3, backend: 'fake' })
    expect(await questions.find(owner.id, projectId, question.id)).toMatchObject({
      phase: 'done',
      answer,
      answeredAt: expect.any(Date),
    })
    expect(await work.pending(question.id)).toBeNull()

    const failed = await questions.create(owner.id, { projectId, text: 'Rischi?', lang: 'it' })
    await work.saveFailure(failed.id, 'model_busy')
    expect(
      (await questions.list(owner.id, projectId, 10)).map((q) => [q.text, q.phase, q.error]),
    ).toEqual([
      ['Rischi?', 'failed', 'model_busy'],
      ['Budget?', 'done', null],
    ])
    await questions.remove(owner.id, failed.id)
    expect(await questions.list(owner.id, projectId, 10)).toHaveLength(1)
  })
})
