import { describe, expect, it } from 'vitest'
import { PUBLIC_URL, setup } from './support.ts'

describe('login flow', () => {
  it('redirects to the issuer with a short-lived attempt cookie', async () => {
    const { api, identity } = setup()
    const res = await api.request('/api/auth/login?return_to=/projects&login_hint=paola')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://issuer.test/authorize')
    expect(res.headers.get('set-cookie')).toMatch(
      /^ob_login=.+Path=\/api\/auth; HttpOnly; SameSite=Lax/,
    )
    expect(identity.lastHint).toBe('paola')
  })

  it('opens a session and returns to the requested page', async () => {
    const { signIn, logger } = setup()
    const { callback, cookie } = await signIn()
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(`${PUBLIC_URL}/projects`)
    expect(cookie).toMatch(/ob_session=.+; ob_locale=it/)
    expect(logger.entries.at(-1)?.message).toBe('login')
  })

  it('sends failed logins to the login page without a session', async () => {
    const { api, logger } = setup()
    const res = await api.request('/api/auth/callback?code=c&state=st')
    expect(res.headers.get('location')).toBe(`${PUBLIC_URL}/login?error=login_failed`)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ob_session=t'))).toBe(false)
    expect(logger.entries.at(-1)).toMatchObject({ level: 'error', message: 'login failed' })
  })

  it('logs out: revokes the session and returns the issuer logout url', async () => {
    const { api, signIn } = setup()
    const { cookie } = await signIn()
    const res = await api.request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL },
    })
    expect(await res.json()).toEqual({ redirectTo: 'https://issuer.test/logout' })
    expect((await api.request('/api/me', { headers: { cookie } })).status).toBe(401)
  })

  it('refuses a cross-site logout', async () => {
    const { api } = setup()
    const res = await api.request('/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    })
    expect(res.status).toBe(403)
  })
})

describe('session and CSRF', () => {
  it('returns the user and the CSRF token', async () => {
    const { api, signIn } = setup()
    const { cookie, csrfToken } = await signIn()
    const me = await (await api.request('/api/me', { headers: { cookie } })).json()
    expect(me).toMatchObject({
      user: { displayName: 'Paola Prova', role: 'pm', locale: 'it' },
      csrfToken,
    })
  })

  it('rejects unsafe requests without the token or from another origin', async () => {
    const { api, signIn } = setup()
    const auth = await signIn()
    const body = JSON.stringify({ locale: 'en' })
    const headers = { cookie: auth.cookie, 'content-type': 'application/json' }
    const noToken = await api.request('/api/me', { method: 'PATCH', headers, body })
    expect(noToken.status).toBe(403)
    const crossSite = await api.request('/api/me', {
      method: 'PATCH',
      headers: { ...headers, 'x-csrf-token': auth.csrfToken, origin: 'https://evil.test' },
      body,
    })
    expect(crossSite.status).toBe(403)
  })

  it('changes the locale and its cookie', async () => {
    const { api, signIn, send } = setup()
    const auth = await signIn()
    const res = await send('/api/me', 'PATCH', auth, { locale: 'en' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/^ob_locale=en/)
    const me = (await (
      await api.request('/api/me', { headers: { cookie: auth.cookie } })
    ).json()) as {
      user: { locale: string }
    }
    expect(me.user.locale).toBe('en')
    expect((await send('/api/me', 'PATCH', auth, { locale: 'fr' })).status).toBe(400)
  })
})
