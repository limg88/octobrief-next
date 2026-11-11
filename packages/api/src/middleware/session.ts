import { ApplicationError, resolveSession } from '@octobrief/application'
import { isAdmin } from '@octobrief/domain'
import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { CSRF_HEADER, SESSION_COOKIE } from '../cookies.ts'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Requires a valid session; on unsafe methods also the CSRF token and a same-origin request. */
export function requireSession(deps: ApiDependencies) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const session = await resolveSession(deps, getCookie(c, SESSION_COOKIE))
    if (!session) throw new ApplicationError('unauthenticated', 'no valid session')
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      const sameOrigin = origin === undefined || origin === deps.publicUrl
      if (!sameOrigin || c.req.header(CSRF_HEADER) !== session.csrfToken) {
        throw new ApplicationError('forbidden', 'cross-site request refused')
      }
    }
    c.set('session', session)
    await next()
  })
}

export const requireAdmin = createMiddleware<ApiEnv>(async (c, next) => {
  if (!isAdmin(c.get('session').user)) throw new ApplicationError('forbidden', 'admins only')
  await next()
})
