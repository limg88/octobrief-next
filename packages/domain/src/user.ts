export const USER_ROLES = ['pm', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const LOCALES = ['it', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'it'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

export interface User {
  readonly id: string
  readonly displayName: string
  readonly email: string | null
  readonly role: UserRole
  readonly locale: Locale
}

export function isAdmin(user: Pick<User, 'role'>): boolean {
  return user.role === 'admin'
}
