import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { type FactView, getKnowledge } from '@octobrief/application'
import { FACT_KINDS, FACT_STATES } from '@octobrief/domain'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { ErrorSchema, LocatorSchema } from './schemas.ts'

const FactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(FACT_KINDS),
    key: z.string(),
    statement: z.string(),
    value: z.string().nullable(),
    state: z.enum(FACT_STATES),
    createdAt: z.iso.datetime(),
    sources: z.array(
      z.object({
        documentId: z.string(),
        fileName: z.string(),
        locator: LocatorSchema,
        excerpt: z.string(),
      }),
    ),
  })
  .openapi('Fact')

const KnowledgeSchema = z
  .object({
    facts: z.array(FactSchema),
    progress: z.object({ reading: z.number(), failed: z.number(), compiled: z.number() }),
  })
  .openapi('Knowledge')

function toDto(fact: FactView) {
  return {
    id: fact.id,
    kind: fact.kind,
    key: fact.key,
    statement: fact.statement,
    value: fact.value,
    state: fact.state,
    createdAt: fact.createdAt.toISOString(),
    sources: fact.sources.map((source) => ({ ...source })),
  }
}

const knowledgeRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/knowledge',
  tags: ['knowledge'],
  summary: 'What the documents of a project say: facts with the exact text they come from',
  request: { params: z.object({ slug: z.string().min(1).max(80) }) },
  responses: {
    200: {
      description: 'Facts and reading progress',
      content: { 'application/json': { schema: KnowledgeSchema } },
    },
    404: {
      description: 'Project not found or not visible',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

export function registerKnowledgeRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.openapi(knowledgeRoute, async (c) => {
    const { facts, progress } = await getKnowledge(
      deps,
      c.get('session').user,
      c.req.valid('param').slug,
    )
    return c.json({ facts: facts.map(toDto), progress }, 200)
  })
}
