import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  askQuestion,
  deleteQuestion,
  getQuestion,
  listQuestions,
  type Question,
  watchQuestion,
} from '@octobrief/application'
import { MAX_QUESTION_LENGTH, QUESTION_PHASES } from '@octobrief/domain'
import { streamSSE } from 'hono/streaming'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { ErrorSchema } from './schemas.ts'

const summaryFields = {
  id: z.string(),
  text: z.string(),
  phase: z.enum(QUESTION_PHASES),
  error: z.string().nullable(),
  askedAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
}
const QuestionSummarySchema = z.object(summaryFields).openapi('QuestionSummary')
const QuestionSchema = z
  .object({
    ...summaryFields,
    // The verified answer: segments with their checked sources, contradictions, absences and
    // the list of checks (`VerifiedAnswer` of the domain, dates as ISO strings).
    answer: z.record(z.string(), z.unknown()).nullable(),
  })
  .openapi('Question')

function toSummary(question: Question) {
  return {
    id: question.id,
    text: question.text,
    phase: question.phase,
    error: question.error,
    askedAt: question.askedAt.toISOString(),
    answeredAt: question.answeredAt?.toISOString() ?? null,
  }
}

function toDto(question: Question) {
  const answer = question.answer
    ? (JSON.parse(JSON.stringify(question.answer)) as Record<string, unknown>)
    : null
  return { ...toSummary(question), answer }
}

const SlugParams = z.object({ slug: z.string().min(1).max(80) })
const QuestionParams = SlugParams.extend({ id: z.uuid() })
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const notVisible = { description: 'Project or question not found', content: json(ErrorSchema) }

const listRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/questions',
  tags: ['ask'],
  summary: 'The questions the signed-in person asked on a project, newest first',
  request: { params: SlugParams },
  responses: {
    200: {
      description: 'Questions',
      content: json(z.object({ questions: z.array(QuestionSummarySchema) }).openapi('Questions')),
    },
    404: notVisible,
  },
})

const askRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/questions',
  tags: ['ask'],
  summary: 'Ask a question; the answer is prepared in the background',
  request: {
    params: SlugParams,
    body: { content: json(z.object({ text: z.string().max(MAX_QUESTION_LENGTH * 2) })) },
  },
  responses: {
    201: { description: 'Question queued', content: json(QuestionSummarySchema) },
    400: { description: 'Empty or too long', content: json(ErrorSchema) },
    404: notVisible,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/questions/{id}',
  tags: ['ask'],
  summary: 'A question with its verified answer, when ready',
  request: { params: QuestionParams },
  responses: { 200: { description: 'Question', content: json(QuestionSchema) }, 404: notVisible },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/questions/{id}',
  tags: ['ask'],
  summary: 'Remove a question from the history',
  request: { params: QuestionParams },
  responses: { 204: { description: 'Removed' }, 404: notVisible },
})

const eventsRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/questions/{id}/events',
  tags: ['ask'],
  summary: 'Progress of a question as server-sent events: one `phase` event per change',
  request: { params: QuestionParams },
  responses: {
    200: {
      description: 'Events until the question is settled',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    404: notVisible,
  },
})

export function registerQuestionRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.openapi(listRoute, async (c) => {
    const questions = await listQuestions(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json({ questions: questions.map(toSummary) }, 200)
  })

  app.openapi(askRoute, async (c) => {
    const question = await askQuestion(
      deps,
      c.get('session').user,
      c.req.valid('param').slug,
      c.req.valid('json').text,
    )
    return c.json(toSummary(question), 201)
  })

  app.openapi(getRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    return c.json(toDto(await getQuestion(deps, c.get('session').user, slug, id)), 200)
  })

  app.openapi(deleteRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await deleteQuestion(deps, c.get('session').user, slug, id)
    return c.body(null, 204)
  })

  app.openapi(eventsRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    const viewer = c.get('session').user
    // Looked up before the stream starts: a question that is not there answers 404, not a stream.
    await getQuestion(deps, viewer, slug, id)
    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal
      for await (const question of watchQuestion(deps, viewer, slug, id, { signal })) {
        await stream.writeSSE({
          event: 'phase',
          data: JSON.stringify({ phase: question.phase, error: question.error }),
        })
      }
    })
  })
}
