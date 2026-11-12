import {
  type EvidenceId,
  type Extraction,
  type Fact,
  type FactId,
  newId,
  type ProjectId,
  type ProposedFact,
  type User,
} from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { protectedRunner } from '../src/model/protected-runner.ts'
import { ModelError, type ModelResponse, type ModelRunner } from '../src/ports/model-runner.ts'
import { createProcessDocumentHandler, uploadDocument } from '../src/use-cases/documents.ts'
import {
  createCompileDocumentHandler,
  getKnowledge,
  mergeProposals,
} from '../src/use-cases/knowledge.ts'
import { createProject } from '../src/use-cases/projects.ts'
import { fakeModelRunner } from './fake-model-runner.ts'
import {
  FakeExtractor,
  InMemoryBlobs,
  InMemoryDocuments,
  InMemoryJobQueue,
  InMemoryKnowledge,
  InMemoryProjects,
  InMemoryUsers,
  RecordingLogger,
} from './fakes.ts'

const NOW = new Date('2026-11-12T09:00:00Z')
const LINES = ['Budget: 120.000 euro approvati dal comitato.', 'Mario Rossi segue il fornitore.']

const extraction: Extraction = {
  extractor: 'test/1',
  chunks: LINES.map((text, i) => ({ locator: { kind: 'line', from: i + 1, to: i + 1 }, text })),
  truncated: false,
  metadataDate: null,
  warnings: [],
}

const answer = (facts: unknown[]): ModelResponse => ({
  message: { role: 'assistant', content: JSON.stringify({ facts }) },
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
  backend: 'fake',
})

const budgetFact = (value: string, excerpt: string) => ({
  kind: 'economics',
  subject: 'Budget',
  statement: `Il budget è ${value}.`,
  value,
  sources: [{ n: 0, excerpt }],
})

async function setup(runner: ModelRunner) {
  const users = new InMemoryUsers()
  const projects = new InMemoryProjects(users)
  const documents = new InMemoryDocuments(projects, users)
  const knowledge = new InMemoryKnowledge(documents)
  const blobs = new InMemoryBlobs()
  const queue = new InMemoryJobQueue()
  const logger = new RecordingLogger()
  const deps = { users, projects, documents, blobs, queue, facts: knowledge }
  const paola: User = users.add({
    id: 'paola',
    displayName: 'Paola Prova',
    email: 'paola@example.test',
    role: 'pm',
    locale: 'it',
  })
  const outsider: User = users.add({ ...paola, id: 'olga', email: 'olga@example.test' })
  const project = await createProject(deps, paola, { name: 'Aurora' })
  const process = createProcessDocumentHandler({
    store: documents,
    blobs,
    extractor: new FakeExtractor(() => extraction),
    jobs: queue,
    logger,
  })
  const compile = createCompileDocumentHandler({ knowledge, runner, logger, now: () => NOW })
  const ready = async (fileName: string) => {
    const document = await uploadDocument(deps, paola, project.slug, {
      fileName,
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(fileName),
    })
    await process({ documentId: document.id })
    return document.id
  }
  return { deps, knowledge, queue, logger, project, paola, outsider, compile, ready }
}

describe('compiling a document', () => {
  it('queues the reading after extraction and stores facts with their exact source', async () => {
    const runner = fakeModelRunner([answer([budgetFact('120.000 euro', LINES[0] as string)])])
    const { deps, knowledge, queue, paola, project, compile, ready } = await setup(runner)
    const documentId = await ready('SAL-2026-11-04.txt')
    expect([...queue.jobs.values()].map((job) => job.name)).toEqual([
      'document.process',
      'document.compile',
    ])

    await compile({ documentId })

    const { facts, progress } = await getKnowledge(deps, paola, project.slug)
    expect(progress).toEqual({ reading: 0, failed: 0, compiled: 1 })
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      kind: 'economics',
      key: 'economics:budget',
      value: '120.000 euro',
      state: 'active',
      sources: [
        {
          documentId,
          fileName: 'SAL-2026-11-04.txt',
          locator: { kind: 'line', from: 1, to: 1 },
          excerpt: LINES[0],
        },
      ],
    })
    expect(knowledge.embeddings.size).toBe(0)

    // Already compiled: a second delivery of the job does nothing.
    await compile({ documentId })
    expect(runner.requests).toHaveLength(1)
  })

  it('drops a fact whose excerpt is not in the text', async () => {
    const runner = fakeModelRunner([answer([budgetFact('120.000 euro', 'Budget: 999 euro mai')])])
    const { knowledge, compile, ready } = await setup(runner)
    await compile({ documentId: await ready('nota.txt') })
    expect(knowledge.stored).toEqual([])
  })

  it('keeps two documents that disagree side by side, both contested', async () => {
    const runner = fakeModelRunner([
      answer([budgetFact('120.000 euro', LINES[0] as string)]),
      answer([
        {
          ...budgetFact('120.000', LINES[0] as string),
          statement: 'Il budget approvato è di 120.000 euro.',
          value: 'approvati 120.000',
        },
      ]),
    ])
    const { knowledge, compile, ready } = await setup(runner)
    await compile({ documentId: await ready('primo.txt') })
    await compile({ documentId: await ready('secondo.txt') })
    expect(knowledge.stored.map((fact) => fact.state)).toEqual(['contested', 'contested'])
  })

  it('stores one vector per chunk when the runner has an encoder', async () => {
    const chat = fakeModelRunner([answer([])])
    const runner: ModelRunner = {
      ...chat,
      embedding: { model: 'enc', digest: 'd1', backend: 'fake' },
      embed: async ({ texts }) => ({
        vectors: texts.map(() => [1, 0]),
        encoder: { model: 'enc', digest: 'd1' },
        usage: { inputTokens: 0 },
        backend: 'fake',
      }),
    }
    const { knowledge, compile, ready } = await setup(runner)
    const documentId = await ready('nota.txt')
    await compile({ documentId })
    expect(knowledge.embeddings.get(documentId)).toEqual({
      encoder: { model: 'enc', digest: 'd1' },
      vectors: [
        [1, 0],
        [1, 0],
      ],
    })
  })

  it('records a stable code when the model fails and lets the queue retry', async () => {
    const runner: ModelRunner = {
      backend: 'fake',
      run: async () => {
        throw new ModelError('unavailable', 'gateway down')
      },
    }
    const { deps, knowledge, logger, paola, project, compile, ready } = await setup(runner)
    const documentId = await ready('nota.txt')
    await expect(compile({ documentId })).rejects.toThrow(ModelError)
    expect(knowledge.status.get(documentId)).toEqual({
      status: 'failed',
      error: 'model_unavailable',
    })
    expect(logger.entries.at(-1)).toMatchObject({ message: 'document compile failed' })
    const { progress } = await getKnowledge(deps, paola, project.slug)
    expect(progress).toEqual({ reading: 0, failed: 1, compiled: 0 })
  })

  it('records the answer that never took the right form, and any other failure', async () => {
    const malformed = { ...answer([]), message: { role: 'assistant' as const, content: 'no' } }
    const first = await setup(fakeModelRunner([malformed, malformed]))
    const documentId = await first.ready('nota.txt')
    await expect(first.compile({ documentId })).rejects.toThrow()
    expect(first.knowledge.status.get(documentId)?.error).toBe('compile_model_output_invalid')

    const second = await setup(fakeModelRunner([answer([])]))
    second.knowledge.facts = async () => {
      throw new Error('database down')
    }
    const other = await second.ready('nota.txt')
    await expect(second.compile({ documentId: other })).rejects.toThrow('database down')
    expect(second.knowledge.status.get(other)?.error).toBe('compile_failed')
  })

  it('never shows a real name to the model and puts it back in the facts', async () => {
    const seen: string[] = []
    const inner: ModelRunner = {
      backend: 'fake',
      run: async (request) => {
        const content = request.messages.map((m) => m.content ?? '').join('\n')
        seen.push(content)
        const placeholder = /\[PERSONA_\d+\]/.exec(content)?.[0] as string
        return answer([
          {
            kind: 'person',
            subject: placeholder,
            statement: `${placeholder} segue il fornitore.`,
            value: null,
            sources: [{ n: 1, excerpt: `${placeholder} segue il fornitore.` }],
          },
        ])
      },
    }
    const context = await setup(inner)
    context.knowledge.knownPeople = [{ displayName: 'Mario Rossi' }]
    const guarded = protectedRunner(inner, {
      people: () => context.knowledge.people(),
      resolveProject: async () => ({ dataNature: 'real' }),
      allowedForReal: async () => ['fake'],
    })
    const compile = createCompileDocumentHandler({
      knowledge: context.knowledge,
      runner: guarded,
      logger: context.logger,
    })
    await compile({ documentId: await context.ready('nota.txt') })
    expect(seen.join('\n')).not.toContain('Mario')
    expect(context.knowledge.stored[0]).toMatchObject({
      statement: 'Mario Rossi segue il fornitore.',
      sources: [{ excerpt: LINES[1] }],
    })
  })

  it('refuses a backend that is not allowed before any call', async () => {
    const inner = fakeModelRunner([answer([])])
    const context = await setup(inner)
    const guarded = protectedRunner(inner, {
      people: async () => [],
      resolveProject: async () => ({ dataNature: 'real' }),
      allowedForReal: async () => [],
    })
    const compile = createCompileDocumentHandler({
      knowledge: context.knowledge,
      runner: guarded,
      logger: context.logger,
    })
    const documentId = await context.ready('nota.txt')
    await expect(compile({ documentId })).rejects.toThrow(ModelError)
    expect(inner.requests).toEqual([])
    expect(context.knowledge.status.get(documentId)?.error).toBe('model_not_allowed')
  })

  it('shows nothing of a project to who is not a member', async () => {
    const { deps, outsider, project } = await setup(fakeModelRunner([]))
    await expect(getKnowledge(deps, outsider, project.slug)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('ignores a document that is gone', async () => {
    const { compile, logger } = await setup(fakeModelRunner([]))
    await compile({ documentId: '00000000-0000-4000-8000-000000000000' })
    expect(logger.entries).toEqual([])
  })
})

describe('mergeProposals', () => {
  const projectId = newId<ProjectId>()
  const context = { projectId, now: NOW, lang: 'it' as const }
  const source = (evidenceId = newId<EvidenceId>()) => ({
    evidenceId,
    locator: { kind: 'line' as const, from: 1, to: 1 },
    excerpt: 'Budget: 120.000 euro',
  })
  const proposal = (value: string | null, over: Partial<ProposedFact> = {}): ProposedFact => ({
    kind: 'economics',
    key: 'economics:budget',
    statement: 'Il budget.',
    value,
    sources: [source()],
    ...over,
  })
  const stored = (over: Partial<Fact> = {}): Fact => ({
    id: newId<FactId>(),
    projectId,
    kind: 'economics',
    key: 'economics:budget',
    statement: 'Il budget.',
    value: '120.000',
    sources: [source()],
    origin: 'compile',
    state: 'active',
    lockedByPm: false,
    pmAsserted: false,
    createdAt: NOW,
    ...over,
  })

  it('adds the sources of a proposal that agrees, once', () => {
    const fact = stored()
    const again = proposal('120000')
    const { changes } = mergeProposals([fact], [again, again], context)
    expect(changes).toEqual([{ kind: 'add_sources', factId: fact.id, sources: again.sources }])
  })

  it('adds sources to the contested fact that agrees instead of contesting again', () => {
    const first = stored({ state: 'contested' })
    const second = stored({ state: 'contested', value: '135.000' })
    const { changes } = mergeProposals([first, second], [proposal('135.000')], context)
    expect(changes).toMatchObject([{ kind: 'add_sources', factId: second.id }])
  })

  it('contests a different value from another document and counts what it refuses', () => {
    const fact = stored()
    const { changes, rejected } = mergeProposals(
      [fact],
      [proposal('135.000'), proposal('1', { sources: [] })],
      context,
    )
    expect(changes).toMatchObject([
      { kind: 'contest', factId: fact.id, fact: { state: 'contested', value: '135.000' } },
    ])
    expect(rejected).toBe(1)
  })

  it('lets a new reading take the place of a superseded fact', () => {
    const fact = stored({ state: 'superseded' })
    const { changes } = mergeProposals([fact], [proposal('135.000')], context)
    expect(changes).toMatchObject([{ kind: 'replace', factId: fact.id }])
  })
})
