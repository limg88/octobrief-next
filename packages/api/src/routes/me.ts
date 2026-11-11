import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { changeLocale } from '@octobrief/application'
import { LOCALES, USER_ROLES } from '@octobrief/domain'
import { setCookie } from 'hono/cookie'
import { LOCALE_COOKIE, ONE_YEAR_SECONDS } from '../cookies.ts'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { requireSession } from '../middleware/session.ts'

const MeSchema = z
  .object({
    user: z.object({
      id: z.string(),
      displayName: z.string(),
      email: z.string().nullable(),
      role: z.enum(USER_ROLES),
      locale: z.enum(LOCALES),
    }),
    csrfToken: z.string(),
  })
  .openapi('Me')

const getMeRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['session'],
  summary: 'The signed-in user and the CSRF token for unsafe requests',
  responses: {
    200: { description: 'Current session', content: { 'application/json': { schema: MeSchema } } },
  },
})

const updateMeRoute = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['session'],
  summary: 'Change the preferences of the signed-in user',
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ locale: z.enum(LOCALES) }) } },
    },
  },
  responses: { 204: { description: 'Preferences saved' } },
})

export function registerMeRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.use('/me', requireSession(deps))

  app.openapi(getMeRoute, (c) => {
    const { user, csrfToken } = c.get('session')
    return c.json({ user, csrfToken }, 200)
  })

  app.openapi(updateMeRoute, async (c) => {
    const { locale } = c.req.valid('json')
    await changeLocale(deps, c.get('session').user, locale)
    setCookie(c, LOCALE_COOKIE, locale, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
    })
    return c.body(null, 204)
  })
}
