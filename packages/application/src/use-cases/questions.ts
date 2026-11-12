import {
  type AnswerStore,
  DomainError,
  isTerminalPhase,
  type KnowledgeReader,
  type ProjectId,
  parseQuestionText,
  type TrackerReader,
  type User,
  type UserId,
} from '@octobrief/domain'
import { AskError, askProject } from '../ask/ask.ts'
import { ApplicationError } from '../errors.ts'
import type { JobQueue } from '../ports/job-queue.ts'
import type { Logger } from '../ports/logger.ts'
import { ModelError, type ModelRunner, modelErrorCode } from '../ports/model-runner.ts'
import type { Question, QuestionRepository, QuestionWorkStore } from '../ports/question-stores.ts'
import { getProject, type ProjectDependencies } from './projects.ts'

/** Questions of the history shown at most. */
export const QUESTION_HISTORY_LIMIT = 50
/** How often the progress of a question is looked at while it is being answered. */
export const QUESTION_POLL_MS = 400
/** The longest a question is watched: a job that never settles is not waited for forever. */
export const QUESTION_WATCH_MS = 10 * 60 * 1000
/** Stored when answering fails for a reason that is neither the model's nor the answer's. */
const UNEXPECTED_FAILURE = 'ask_failed'

export interface QuestionDependencies extends ProjectDependencies {
  readonly questions: QuestionRepository
  readonly queue: JobQueue
}

/** Records the question and queues its answer; the answer arrives through the events. */
export async function askQuestion(
  deps: QuestionDependencies,
  viewer: User,
  slug: string,
  rawText: string,
): Promise<Question> {
  const project = await getProject(deps, viewer, slug)
  let text: string
  try {
    text = parseQuestionText(rawText)
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ApplicationError('invalid', error.code, { cause: error })
    }
    throw error
  }
  const question = await deps.questions.create(viewer.id, {
    projectId: project.id,
    text,
    lang: 'it',
  })
  await deps.queue.enqueue('question.answer', { questionId: question.id })
  return question
}

export async function listQuestions(
  deps: QuestionDependencies,
  viewer: User,
  slug: string,
): Promise<Question[]> {
  const project = await getProject(deps, viewer, slug)
  return deps.questions.list(viewer.id, project.id, QUESTION_HISTORY_LIMIT)
}

export async function getQuestion(
  deps: QuestionDependencies,
  viewer: User,
  slug: string,
  questionId: string,
): Promise<Question> {
  const project = await getProject(deps, viewer, slug)
  const question = await deps.questions.find(viewer.id, project.id, questionId)
  if (!question) throw new ApplicationError('not_found', 'question not found')
  return question
}

export async function deleteQuestion(
  deps: QuestionDependencies,
  viewer: User,
  slug: string,
  questionId: string,
): Promise<void> {
  const question = await getQuestion(deps, viewer, slug, questionId)
  await deps.questions.remove(viewer.id, question.id)
}

/**
 * The question each time its phase changes, until it is settled (or `signal` aborts, or the
 * watch runs out): what a progress stream sends.
 */
export async function* watchQuestion(
  deps: QuestionDependencies,
  viewer: User,
  slug: string,
  questionId: string,
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): AsyncGenerator<Question> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const until = now() + QUESTION_WATCH_MS
  let seen: string | null = null
  while (!options.signal?.aborted && now() < until) {
    const question = await getQuestion(deps, viewer, slug, questionId)
    if (question.phase !== seen) {
      seen = question.phase
      yield question
    }
    if (isTerminalPhase(question.phase)) return
    await sleep(QUESTION_POLL_MS)
  }
}

/** What reading a project needs: its documents, facts and tracker items, in short transactions. */
export interface AskReading<Tx> {
  readonly reader: KnowledgeReader<Tx>
  readonly store: AnswerStore<Tx>
  readonly tracker?: TrackerReader<Tx>
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

export interface AnswerDependencies<Tx> {
  readonly questions: QuestionWorkStore
  readonly reading: AskReading<Tx>
  /** Already protected: guarded and pseudonymizing. */
  readonly runner: ModelRunner
  readonly logger: Logger
  readonly now?: () => Date
}

function failureCode(error: unknown): string {
  if (error instanceof AskError) return `ask_${error.code}`
  if (error instanceof ModelError) return modelErrorCode(error)
  return UNEXPECTED_FAILURE
}

/**
 * Worker job: the model reads the project through the read-only tools and answers; the code
 * checks every sentence against what was really read before anything is stored. A failure is
 * recorded on the question with a stable code and not raised: the PM asks again.
 */
export function createAnswerQuestionHandler<Tx>(deps: AnswerDependencies<Tx>) {
  const now = deps.now ?? (() => new Date())
  return async ({ questionId }: { questionId: string }): Promise<void> => {
    const question = await deps.questions.pending(questionId)
    if (!question) return
    try {
      await deps.questions.setPhase(question.id, 'reading')
      const result = await askProject(
        deps.runner,
        {
          projectId: question.projectId as ProjectId,
          userId: question.askedBy as UserId,
          question: question.text,
          lang: question.lang,
        },
        {
          ...deps.reading,
          now: now(),
          onChecking: () => deps.questions.setPhase(question.id, 'checking'),
        },
      )
      await deps.questions.saveAnswer(question.id, result.answer, {
        turns: result.turns,
        backend: result.backend,
      })
      deps.logger.info('question answered', {
        questionId,
        turns: result.turns,
        attempts: result.attempts,
        segments: result.answer.segments.length,
        anomalies: result.answer.checks.anomalies,
      })
    } catch (error) {
      const code = failureCode(error)
      await deps.questions.saveFailure(question.id, code)
      deps.logger.error('question failed', { questionId, code })
    }
  }
}
