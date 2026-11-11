import type { ActiveSession } from '@octobrief/application'

/** Hono context variables set by the middleware. */
export interface ApiEnv {
  Variables: { session: ActiveSession }
}
