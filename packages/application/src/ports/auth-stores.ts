import type { Locale, User } from '@octobrief/domain'
import type { LoginIdentity, PendingLogin } from './identity-provider.ts'

export interface UserRepository {
  /** Creates or refreshes the user of a login; `promoteToAdmin` never demotes. */
  upsertFromLogin(identity: LoginIdentity, promoteToAdmin: boolean): Promise<User>
  findByEmail(email: string): Promise<User | null>
  updateLocale(userId: string, locale: Locale): Promise<void>
}

export interface ActiveSession {
  readonly user: User
  readonly csrfToken: string
  readonly expiresAt: Date
}

/** Server-side sessions: the browser holds an opaque token, the store only its hash. */
export interface SessionStore {
  create(userId: string, expiresAt: Date): Promise<{ token: string; csrfToken: string }>
  find(token: string, now: Date): Promise<ActiveSession | null>
  revoke(token: string): Promise<void>
}

export interface LoginAttempt extends PendingLogin {
  readonly returnTo: string
}

/** Single-use storage for the authorization requests in flight. */
export interface LoginAttemptStore {
  save(attempt: LoginAttempt, expiresAt: Date): Promise<string>
  /** Returns and deletes the attempt; null when unknown or expired. */
  take(id: string, now: Date): Promise<LoginAttempt | null>
}
