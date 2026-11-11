import { describe, expect, it } from 'vitest'
import { ApplicationError } from '../src/errors.ts'
import {
  type AuthDependencies,
  beginLogin,
  changeLocale,
  completeLogin,
  LOGIN_ATTEMPT_TTL_MS,
  logout,
  resolveSession,
  SESSION_TTL_MS,
} from '../src/use-cases/auth.ts'
import {
  FakeIdentityProvider,
  InMemoryLoginAttempts,
  InMemorySessions,
  InMemoryUsers,
} from './fakes.ts'

const START = new Date('2026-11-11T10:00:00Z')

function setup(adminEmails: string[] = []) {
  const users = new InMemoryUsers()
  let now = START
  const deps: AuthDependencies = {
    identity: new FakeIdentityProvider(),
    users,
    sessions: new InMemorySessions(users),
    loginAttempts: new InMemoryLoginAttempts(),
    adminEmails: new Set(adminEmails),
    now: () => now,
  }
  return {
    deps,
    users,
    identity: deps.identity as FakeIdentityProvider,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

describe('login', () => {
  it('runs the whole flow and opens a session', async () => {
    const { deps } = setup()
    const { authorizationUrl, attemptId } = await beginLogin(deps, {
      returnTo: '/projects/alpha',
      loginHint: ' paola ',
    })
    expect(authorizationUrl).toBe('https://issuer.test/authorize')
    const result = await completeLogin(deps, { attemptId, callbackQuery: '?code=x&state=st' })
    expect(result.returnTo).toBe('/projects/alpha')
    expect(result.user.role).toBe('pm')
    expect(result.expiresAt.getTime() - START.getTime()).toBe(SESSION_TTL_MS)
    const session = await resolveSession(deps, result.sessionToken)
    expect(session?.user.id).toBe(result.user.id)
  })

  it('passes a sane login hint and drops an oversized one', async () => {
    const { deps, identity } = setup()
    await beginLogin(deps, { returnTo: null, loginHint: ' paola ' })
    expect(identity.lastHint).toBe('paola')
    await beginLogin(deps, { returnTo: null, loginHint: 'x'.repeat(300) })
    expect(identity.lastHint).toBeNull()
  })

  it('never returns to another site', async () => {
    const { deps } = setup()
    const { attemptId } = await beginLogin(deps, {
      returnTo: '//evil.test',
      loginHint: null,
    })
    const result = await completeLogin(deps, { attemptId, callbackQuery: '?state=st' })
    expect(result.returnTo).toBe('/')
  })

  it('promotes configured admins only when the email is verified', async () => {
    const { deps, identity } = setup(['paola.prova@example.test'])
    const first = await beginLogin(deps, { returnTo: null, loginHint: null })
    const admin = await completeLogin(deps, {
      attemptId: first.attemptId,
      callbackQuery: '?state=st',
    })
    expect(admin.user.role).toBe('admin')

    identity.identity = { ...identity.identity, externalSubject: 'other|x', emailVerified: false }
    const second = await beginLogin(deps, { returnTo: null, loginHint: null })
    const unverified = await completeLogin(deps, {
      attemptId: second.attemptId,
      callbackQuery: '?state=st',
    })
    expect(unverified.user.role).toBe('pm')
  })

  it('rejects unknown, reused and expired attempts', async () => {
    const { deps, advance } = setup()
    await expect(completeLogin(deps, { attemptId: null, callbackQuery: '' })).rejects.toThrow(
      ApplicationError,
    )
    const { attemptId } = await beginLogin(deps, { returnTo: null, loginHint: null })
    await completeLogin(deps, { attemptId, callbackQuery: '?state=st' })
    await expect(completeLogin(deps, { attemptId, callbackQuery: '?state=st' })).rejects.toThrow(
      /unknown or expired/,
    )
    const late = await beginLogin(deps, { returnTo: null, loginHint: null })
    advance(LOGIN_ATTEMPT_TTL_MS + 1)
    await expect(
      completeLogin(deps, { attemptId: late.attemptId, callbackQuery: '?state=st' }),
    ).rejects.toThrow(/unknown or expired/)
  })
})

describe('sessions', () => {
  it('resolves nothing without a token and nothing after expiry', async () => {
    const { deps, advance } = setup()
    expect(await resolveSession(deps, undefined)).toBeNull()
    const { attemptId } = await beginLogin(deps, { returnTo: null, loginHint: null })
    const { sessionToken } = await completeLogin(deps, { attemptId, callbackQuery: '?state=st' })
    advance(SESSION_TTL_MS)
    expect(await resolveSession(deps, sessionToken)).toBeNull()
  })

  it('logout revokes the session and returns the provider logout url', async () => {
    const { deps } = setup()
    const { attemptId } = await beginLogin(deps, { returnTo: null, loginHint: null })
    const { sessionToken } = await completeLogin(deps, { attemptId, callbackQuery: '?state=st' })
    expect(await logout(deps, sessionToken)).toBe('https://issuer.test/logout')
    expect(await resolveSession(deps, sessionToken)).toBeNull()
    expect(await logout(deps, null)).toBe('https://issuer.test/logout')
  })

  it('changes the locale of the user', async () => {
    const { deps, users } = setup()
    const { attemptId } = await beginLogin(deps, { returnTo: null, loginHint: null })
    const { user } = await completeLogin(deps, { attemptId, callbackQuery: '?state=st' })
    await changeLocale(deps, user, 'en')
    expect([...users.bySubject.values()][0]?.locale).toBe('en')
  })
})
