import { type EvidenceId, newId, type SearchHit, type User } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { ApplicationError } from '../src/errors.ts'
import { ModelError, type ModelResponse, type ModelRunner } from '../src/ports/model-runner.ts'
import { addMember, createProject } from '../src/use-cases/projects.ts'
import {
  askQuestion,
  createAnswerQuestionHandler,
  deleteQuestion,
  getQuestion,
  listQuestions,
  QUESTION_WATCH_MS,
  watchQuestion,
} from '../src/use-cases/questions.ts'
import { fakeModelRunner } from './fake-model-runner.ts'
import {
  InMemoryDocuments,
  InMemoryJobQueue,
  InMemoryProjects,
  InMemoryQuestions,
  InMemoryUsers,
  RecordingLogger,
  readingOf,
} from './fakes.ts'

const NOW = new Date('2026-11-12T09:00:00Z')
const evidenceId = newId<EvidenceId>()
const locator = { kind: 'line' as const, from: 3, to: 3 }
const hit: SearchHit = {
  kind: 'chunk',
  evidenceId,
  locator,
  title: 'SAL-Borea.md',
  snippet: 'Budget complessivo: 890.000 €.',
  score: 1,
  sourceDate: new Date('2026-11-04T23:00:00Z'),
  dateSource: 'file_name',
}

const reply = (message: ModelResponse['message'], finish: ModelResponse['finishReason']) => ({
  message,
  finishReason: finish,
  usage: { inputTokens: 1, outputTokens: 1 },
  backend: 'fake',
})
const search = reply(
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'c1', name: 'search_knowledge', arguments: { query: 'budget' } }],
  },
  'tool_calls',
)
const read = reply({ role: 'assistant', content: 'letto' }, 'stop')
const answerOf = (text: string) =>
  reply(
    {
      role: 'assistant',
      content: JSON.stringify({
        lang: 'it',
        segments: [{ text, nature: 'fact', sources: [{ evidenceId, locator }] }],
        contradictions: [],
        absences: [],
      }),
    },
    'stop',
  )

async function setup(runner: ModelRunner = fakeModelRunner([])) {
  const users = new InMemoryUsers()
  const projects = new InMemoryProjects(users)
  const documents = new InMemoryDocuments(projects, users)
  const questions = new InMemoryQuestions(documents)
  const queue = new InMemoryJobQueue()
  const logger = new RecordingLogger()
  const deps = { users, projects, questions, queue }
  const person = (id: string): User =>
    users.add({ id, displayName: id, email: `${id}@example.test`, role: 'pm', locale: 'it' })
  const paola = person('paola')
  const marco = person('marco')
  const olga = person('olga')
  const project = await createProject(deps, paola, { name: 'Borea' })
  await addMember(deps, paola, project.slug, 'marco@example.test')
  const answer = createAnswerQuestionHandler({
    questions,
    reading: readingOf([hit]),
    runner,
    logger,
    now: () => NOW,
  })
  return { deps, questions, queue, logger, paola, marco, olga, project, answer }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof ApplicationError) return error.code
      throw error
    },
  )

describe('asking a question', () => {
  it('records the question, cleaned, and queues its answer', async () => {
    const { deps, queue, paola, project } = await setup()
    const question = await askQuestion(deps, paola, project.slug, '  Qual è   il budget?  ')
    expect(question).toMatchObject({ text: 'Qual è il budget?', phase: 'queued', answer: null })
    expect([...queue.jobs.values()]).toEqual([
      { name: 'question.answer', data: { questionId: question.id }, status: 'queued' },
    ])
  })

  it('refuses an empty question and a project the person does not see', async () => {
    const { deps, paola, olga, project } = await setup()
    expect(await code(askQuestion(deps, paola, project.slug, '   '))).toBe('invalid')
    expect(await code(askQuestion(deps, paola, project.slug, 'x'.repeat(2001)))).toBe('invalid')
    expect(await code(askQuestion(deps, olga, project.slug, 'Budget?'))).toBe('not_found')
  })

  it('keeps a history per person, newest first', async () => {
    const { deps, paola, marco, project } = await setup()
    const first = await askQuestion(deps, paola, project.slug, 'Prima?')
    const second = await askQuestion(deps, paola, project.slug, 'Seconda?')
    expect((await listQuestions(deps, paola, project.slug)).map((q) => q.id)).toEqual([
      second.id,
      first.id,
    ])
    expect(await listQuestions(deps, marco, project.slug)).toEqual([])
    expect(await code(getQuestion(deps, marco, project.slug, first.id))).toBe('not_found')
    await deleteQuestion(deps, paola, project.slug, first.id)
    expect(await listQuestions(deps, paola, project.slug)).toHaveLength(1)
    expect(await code(deleteQuestion(deps, paola, project.slug, first.id))).toBe('not_found')
  })
})

describe('answering a question', () => {
  it('reads, checks and stores an answer whose sentences the sources support', async () => {
    const runner = fakeModelRunner([
      search,
      read,
      answerOf('Il budget complessivo è di 890.000 €.'),
    ])
    const { deps, questions, logger, paola, project, answer } = await setup(runner)
    const question = await askQuestion(deps, paola, project.slug, 'Qual è il budget?')
    const phases: string[] = []
    const setPhase = questions.setPhase.bind(questions)
    questions.setPhase = async (id, phase) => {
      phases.push(phase)
      await setPhase(id, phase)
    }

    await answer({ questionId: question.id })

    expect(phases).toEqual(['reading', 'checking'])
    const stored = await getQuestion(deps, paola, project.slug, question.id)
    expect(stored.phase).toBe('done')
    expect(stored.answer?.segments[0]).toMatchObject({
      text: 'Il budget complessivo è di 890.000 €.',
      sources: [{ verified: true, title: 'SAL-Borea.md' }],
    })
    expect(logger.entries.at(-1)).toMatchObject({
      message: 'question answered',
      fields: { turns: 3, segments: 1, anomalies: 0 },
    })
    // Already settled: a second delivery of the job asks nothing.
    await answer({ questionId: question.id })
    expect(runner.requests).toHaveLength(3)
  })

  it('suspends a sentence whose number no source showed', async () => {
    const runner = fakeModelRunner([search, read, answerOf('Il budget è di 999.999 €.')])
    const { deps, paola, project, answer } = await setup(runner)
    const question = await askQuestion(deps, paola, project.slug, 'Qual è il budget?')
    await answer({ questionId: question.id })
    const stored = await getQuestion(deps, paola, project.slug, question.id)
    expect(stored.answer?.segments[0]).toMatchObject({ text: null, sources: [{ verified: false }] })
    expect(stored.answer?.checks.anomalies).toBeGreaterThan(0)
  })

  it('records a stable code when the model or its answer fails, without raising', async () => {
    const malformed = reply({ role: 'assistant', content: 'non è json' }, 'stop')
    const cases: Array<[ModelRunner, string]> = [
      [fakeModelRunner([read, malformed, malformed]), 'ask_model_output_invalid'],
      [
        {
          backend: 'fake',
          run: async () => {
            throw new ModelError('unavailable', 'down')
          },
        },
        'model_unavailable',
      ],
      [
        {
          backend: 'fake',
          run: async () => {
            throw new Error('boom')
          },
        },
        'ask_failed',
      ],
    ]
    for (const [runner, expected] of cases) {
      const { deps, logger, paola, project, answer } = await setup(runner)
      const question = await askQuestion(deps, paola, project.slug, 'Qual è il budget?')
      await answer({ questionId: question.id })
      const stored = await getQuestion(deps, paola, project.slug, question.id)
      expect(stored).toMatchObject({ phase: 'failed', error: expected, answer: null })
      expect(logger.entries.at(-1)).toMatchObject({ level: 'error', message: 'question failed' })
    }
  })

  it('ignores a question that is gone', async () => {
    const { answer, logger } = await setup()
    await answer({ questionId: crypto.randomUUID() })
    expect(logger.entries).toEqual([])
  })
})

describe('watching a question', () => {
  it('yields each change of phase and stops when the question settles', async () => {
    const { deps, questions, paola, project } = await setup()
    const question = await askQuestion(deps, paola, project.slug, 'Budget?')
    const script = ['reading', 'reading', 'checking', 'done'] as const
    let step = 0
    const sleep = async () => {
      const next = script[step++]
      if (next === 'done') await questions.saveFailure(question.id, 'model_busy')
      else if (next) await questions.setPhase(question.id, next)
    }
    const seen: string[] = []
    for await (const state of watchQuestion(deps, paola, project.slug, question.id, { sleep })) {
      seen.push(state.phase)
    }
    expect(seen).toEqual(['queued', 'reading', 'checking', 'failed'])
  })

  it('stops when the listener goes away or the watch runs out', async () => {
    const { deps, paola, project } = await setup()
    const question = await askQuestion(deps, paola, project.slug, 'Budget?')
    const controller = new AbortController()
    const seen: string[] = []
    const sleep = async () => controller.abort()
    const watch = watchQuestion(deps, paola, project.slug, question.id, {
      sleep,
      signal: controller.signal,
    })
    for await (const state of watch) seen.push(state.phase)
    expect(seen).toEqual(['queued'])

    let clock = 0
    const expiring = watchQuestion(deps, paola, project.slug, question.id, {
      sleep: async () => {
        clock += QUESTION_WATCH_MS
      },
      now: () => clock,
    })
    const phases: string[] = []
    for await (const state of expiring) phases.push(state.phase)
    expect(phases).toEqual(['queued'])
  })
})
