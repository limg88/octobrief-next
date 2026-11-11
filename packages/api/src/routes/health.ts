import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { checkHealth } from '@octobrief/application'
import type { ApiDependencies } from '../dependencies.ts'

const HealthStatusSchema = z.enum(['up', 'down'])

export const HealthReportSchema = z
  .object({
    status: HealthStatusSchema,
    components: z.array(z.object({ name: z.string(), status: HealthStatusSchema })),
  })
  .openapi('HealthReport')

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: 'Health of the web process and the components it depends on',
  responses: {
    200: {
      description: 'Every component is up',
      content: { 'application/json': { schema: HealthReportSchema } },
    },
    503: {
      description: 'At least one component is down',
      content: { 'application/json': { schema: HealthReportSchema } },
    },
  },
})

export function registerHealthRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(healthRoute, async (c) => {
    const report = await checkHealth(deps.probes)
    const body = { status: report.status, components: [...report.components] }
    return report.status === 'up' ? c.json(body, 200) : c.json(body, 503)
  })
}
