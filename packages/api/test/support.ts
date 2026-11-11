import type { HealthProbe, JobQueue } from '@octobrief/application'
import {
  FakeIdentityProvider,
  InMemoryJobQueue,
  InMemoryLoginAttempts,
  InMemoryProjects,
  InMemorySessions,
  InMemoryUsers,
  RecordingLogger,
} from '@octobrief/application/testing'
import { createApi } from '../src/app.ts'
import type { ApiDependencies } from '../src/dependencies.ts'

export const PUBLIC_URL = 'http://app.test'

export function setup(overrides: Partial<ApiDependencies> = {}) {
  const users = new InMemoryUsers()
  const identity = new FakeIdentityProvider()
  const logger = new RecordingLogger()
  const deps: ApiDependencies = {
    probes: [] as HealthProbe[],
    queue: new InMemoryJobQueue() as JobQueue,
    identity,
    users,
    sessions: new InMemorySessions(users),
    loginAttempts: new InMemoryLoginAttempts(),
    projects: new InMemoryProjects(users),
    adminEmails: new Set(['alba@example.test']),
    logger,
    publicUrl: PUBLIC_URL,
    secureCookies: false,
    now: () => new Date('2026-11-11T10:00:00Z'),
    ...overrides,
  }
  const api = createApi(deps)

  /** Signs in through the real routes; returns the cookies and the CSRF token. */
  async function signIn(email = 'paola.prova@example.test', name = 'Paola Prova') {
    identity.identity = {
      externalSubject: `issuer|${email}`,
      displayName: name,
      email,
      emailVerified: true,
    }
    const start = await api.request('/api/auth/login?return_to=/projects')
    const attempt = (start.headers.get('set-cookie') ?? '').split(';')[0] as string
    const callback = await api.request('/api/auth/callback?code=c&state=st', {
      headers: { cookie: attempt },
    })
    const cookie = callback.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .filter((pair) => pair?.startsWith('ob_session=') || pair?.startsWith('ob_locale='))
      .join('; ')
    const me = await api.request('/api/me', { headers: { cookie } })
    const { csrfToken } = (await me.json()) as { csrfToken: string }
    return { cookie, csrfToken, callback }
  }

  function send(
    path: string,
    method: string,
    auth: { cookie: string; csrfToken: string },
    body?: unknown,
  ) {
    return api.request(path, {
      method,
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrfToken,
        origin: PUBLIC_URL,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  return { api, deps, identity, logger, users, signIn, send }
}
