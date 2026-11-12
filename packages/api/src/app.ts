import { OpenAPIHono } from '@hono/zod-openapi'
import type { ApiDependencies } from './dependencies.ts'
import type { ApiEnv } from './env.ts'
import { handleError } from './errors.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerDocumentRoutes } from './routes/documents.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerKnowledgeRoutes } from './routes/knowledge.ts'
import { registerMeRoutes } from './routes/me.ts'
import { registerProjectRoutes } from './routes/projects.ts'
import { registerSourceRoutes } from './routes/sources.ts'
import { registerSystemRoutes } from './routes/system.ts'

export const API_BASE_PATH = '/api'

export function createApi(deps: ApiDependencies) {
  const app = new OpenAPIHono<ApiEnv>().basePath(API_BASE_PATH)
  app.onError((error, c) => {
    const response = handleError(error, c)
    if (response.status >= 500) {
      deps.logger.error('request failed', { path: c.req.path, error: error.name })
    }
    return response
  })
  registerHealthRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerMeRoutes(app, deps)
  registerProjectRoutes(app, deps)
  registerDocumentRoutes(app, deps)
  registerKnowledgeRoutes(app, deps)
  registerSourceRoutes(app, deps)
  registerSystemRoutes(app, deps)
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Octobrief API', version: '0.1.0' },
  })
  return app
}

export type Api = ReturnType<typeof createApi>
