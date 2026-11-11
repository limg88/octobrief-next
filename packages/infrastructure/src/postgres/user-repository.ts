import type { LoginIdentity, UserRepository } from '@octobrief/application'
import type { Locale, User } from '@octobrief/domain'
import type pg from 'pg'

export interface UserRow {
  id: string
  display_name: string
  email: string | null
  role: User['role']
  locale: Locale
}

export const USER_COLUMNS = 'u.id, u.display_name, u.email, u.role, u.locale'

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    locale: row.locale,
  }
}

export function createUserRepository(pool: pg.Pool): UserRepository {
  return {
    async upsertFromLogin(identity: LoginIdentity, promoteToAdmin: boolean) {
      const { rows } = await pool.query<UserRow>(
        `INSERT INTO users AS u (external_subject, display_name, email, email_verified, role)
         VALUES ($1, $2, lower($3), $4, CASE WHEN $5 THEN 'admin' ELSE 'pm' END)
         ON CONFLICT (external_subject) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           role = CASE WHEN $5 THEN 'admin' ELSE u.role END,
           last_login_at = now()
         RETURNING ${USER_COLUMNS}`,
        [
          identity.externalSubject,
          identity.displayName,
          identity.email,
          identity.emailVerified,
          promoteToAdmin,
        ],
      )
      return toUser(rows[0] as UserRow)
    },

    async findByEmail(email: string) {
      const { rows } = await pool.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users u WHERE lower(u.email) = lower($1) AND u.email_verified`,
        [email],
      )
      return rows[0] ? toUser(rows[0]) : null
    },

    async updateLocale(userId: string, locale: Locale) {
      await pool.query('UPDATE users SET locale = $2 WHERE id = $1', [userId, locale])
    },
  }
}
