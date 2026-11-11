import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { getPingStatus, requestPing } from '@octobrief/application'
import { JOB_STATUSES } from '@octobrief/domain'
import type { ApiDependencies } from '../dependencies.ts'

// Diagnostic routes for the web → queue → worker round trip.
// TODO(increment 1): restrict to PMO admins once authentication exists.

const PingAcceptedSchema = z.object({ jobId: z.string() }).openapi('PingAccepted')
const PingStatusSchema = z
  .object({ jobId: z.string(), status: z.enum(JOB_STATUSES as [string, ...string[]]) })
  .openapi('PingStatus')
const ErrorSchema = z.object({ error: z.string() }).openapi('Error')

const requestPingRoute = createRoute({
  method: 'post',
  path: '/system/pings',
  tags: ['system'],
  summary: 'Queue a ping job for the worker',
  responses: {
    202: {
      description: 'Ping queued',
      content: { 'application/json': { schema: PingAcceptedSchema } },
    },
  },
})

const pingStatusRoute = createRoute({
  method: 'get',
  path: '/system/pings/{jobId}',
  tags: ['system'],
  summary: 'Status of a ping job',
  request: { params: z.object({ jobId: z.uuid() }) },
  responses: {
    200: {
      description: 'Ping status',
      content: { 'application/json': { schema: PingStatusSchema } },
    },
    404: {
      description: 'No such ping',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

export function registerSystemRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(requestPingRoute, async (c) => c.json(await requestPing(deps.queue), 202))

  app.openapi(pingStatusRoute, async (c) => {
    const { jobId } = c.req.valid('param')
    const status = await getPingStatus(deps.queue, jobId)
    return status === null
      ? c.json({ error: 'ping_not_found' }, 404)
      : c.json({ jobId, status }, 200)
  })
}
