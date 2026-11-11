import type { Locale, User } from '@octobrief/domain'
import { ApplicationError } from '../errors.ts'
import type {
  ActiveSession,
  LoginAttemptStore,
  SessionStore,
  UserRepository,
} from '../ports/auth-stores.ts'
import type { IdentityProvider } from '../ports/identity-provider.ts'
import { sanitizeReturnTo } from './return-to.ts'

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000
const MAX_LOGIN_HINT = 256

export interface AuthDependencies {
  readonly identity: IdentityProvider
  readonly users: UserRepository
  readonly sessions: SessionStore
  readonly loginAttempts: LoginAttemptStore
  /** Lower-case emails promoted to admin at login (bootstrap of the first admins). */
  readonly adminEmails: ReadonlySet<string>
  readonly now: () => Date
}

export async function beginLogin(
  deps: AuthDependencies,
  input: { returnTo: string | null; loginHint: string | null },
): Promise<{ authorizationUrl: string; attemptId: string }> {
  const hint = input.loginHint?.trim()
  const loginHint = hint && hint.length <= MAX_LOGIN_HINT ? hint : null
  const { authorizationUrl, pending } = await deps.identity.begin({ loginHint })
  const expiresAt = new Date(deps.now().getTime() + LOGIN_ATTEMPT_TTL_MS)
  const attemptId = await deps.loginAttempts.save(
    { ...pending, returnTo: sanitizeReturnTo(input.returnTo) },
    expiresAt,
  )
  return { authorizationUrl, attemptId }
}

export async function completeLogin(
  deps: AuthDependencies,
  input: { attemptId: string | null; callbackQuery: string },
): Promise<{ sessionToken: string; user: User; returnTo: string; expiresAt: Date }> {
  const now = deps.now()
  const attempt = input.attemptId ? await deps.loginAttempts.take(input.attemptId, now) : null
  if (!attempt) throw new ApplicationError('login_failed', 'unknown or expired login attempt')
  const identity = await deps.identity.complete(input.callbackQuery, attempt)
  const promote =
    identity.emailVerified &&
    identity.email !== null &&
    deps.adminEmails.has(identity.email.toLowerCase())
  const user = await deps.users.upsertFromLogin(identity, promote)
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  const { token } = await deps.sessions.create(user.id, expiresAt)
  return { sessionToken: token, user, returnTo: attempt.returnTo, expiresAt }
}

export function resolveSession(
  deps: Pick<AuthDependencies, 'sessions' | 'now'>,
  token: string | null | undefined,
): Promise<ActiveSession | null> {
  return token ? deps.sessions.find(token, deps.now()) : Promise.resolve(null)
}

/** Ends the local session and tells where the provider's session ends. */
export async function logout(
  deps: Pick<AuthDependencies, 'sessions' | 'identity'>,
  token: string | null | undefined,
): Promise<string> {
  if (token) await deps.sessions.revoke(token)
  return deps.identity.logoutUrl()
}

export function changeLocale(
  deps: { users: UserRepository },
  user: User,
  locale: Locale,
): Promise<void> {
  return deps.users.updateLocale(user.id, locale)
}
