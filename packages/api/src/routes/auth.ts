import { beginLogin, completeLogin, logout } from '@octobrief/application'
import type { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  LOCALE_COOKIE,
  LOGIN_COOKIE,
  LOGIN_COOKIE_PATH,
  ONE_YEAR_SECONDS,
  SESSION_COOKIE,
} from '../cookies.ts'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'

const LOGIN_COOKIE_MAX_AGE = 10 * 60
const LOGIN_ERROR_PATH = '/login?error=login_failed'

/**
 * Browser redirects of the OpenID Connect flow. Not in the OpenAPI document: they answer with
 * redirects and cookies, not with JSON.
 */
export function registerAuthRoutes(app: Hono<ApiEnv>, deps: ApiDependencies): void {
  const cookieBase = { httpOnly: true, secure: deps.secureCookies, sameSite: 'Lax' } as const
  const home = (path: string) => new URL(path, deps.publicUrl).toString()

  app.get('/auth/login', async (c) => {
    const { authorizationUrl, attemptId } = await beginLogin(deps, {
      returnTo: c.req.query('return_to') ?? null,
      loginHint: c.req.query('login_hint') ?? null,
    })
    setCookie(c, LOGIN_COOKIE, attemptId, {
      ...cookieBase,
      path: LOGIN_COOKIE_PATH,
      maxAge: LOGIN_COOKIE_MAX_AGE,
    })
    return c.redirect(authorizationUrl, 302)
  })

  app.get('/auth/callback', async (c) => {
    const attemptId = getCookie(c, LOGIN_COOKIE) ?? null
    deleteCookie(c, LOGIN_COOKIE, { path: LOGIN_COOKIE_PATH })
    try {
      const login = await completeLogin(deps, {
        attemptId,
        callbackQuery: new URL(c.req.url).search,
      })
      setCookie(c, SESSION_COOKIE, login.sessionToken, {
        ...cookieBase,
        path: '/',
        expires: login.expiresAt,
      })
      setCookie(c, LOCALE_COOKIE, login.user.locale, {
        ...cookieBase,
        path: '/',
        maxAge: ONE_YEAR_SECONDS,
      })
      deps.logger.info('login', { userId: login.user.id })
      return c.redirect(home(login.returnTo), 302)
    } catch (error) {
      deps.logger.error('login failed', {
        error: error instanceof Error ? error.message : 'unknown',
      })
      return c.redirect(home(LOGIN_ERROR_PATH), 302)
    }
  })

  app.post('/auth/logout', async (c) => {
    const origin = c.req.header('origin')
    if (origin !== undefined && origin !== deps.publicUrl)
      return c.json({ error: 'forbidden' }, 403)
    const target = await logout(deps, getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ redirectTo: target }, 200)
  })
}
