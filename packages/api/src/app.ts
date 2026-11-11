import { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiDependencies } from './dependencies.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerSystemRoutes } from './routes/system.ts'

export const API_BASE_PATH = '/api'

export function createApi(deps: ApiDependencies) {
  const app = new OpenAPIHono().basePath(API_BASE_PATH)
  registerHealthRoutes(app, deps)
  registerSystemRoutes(app, deps)
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Octobrief API', version: '0.0.0' },
  })
  return app
}

export type Api = ReturnType<typeof createApi>
