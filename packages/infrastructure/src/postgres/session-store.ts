import { createHash, randomBytes } from 'node:crypto'
import type { LoginAttempt, LoginAttemptStore, SessionStore } from '@octobrief/application'
import type pg from 'pg'
import { toUser, USER_COLUMNS, type UserRow } from './user-repository.ts'

const TOKEN_BYTES = 32

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Only hashes reach the database: a leaked table does not hand out sessions. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSessionStore(pool: pg.Pool): SessionStore {
  return {
    async create(userId: string, expiresAt: Date) {
      const token = newToken()
      const csrfToken = newToken()
      await pool.query(
        'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
        [hashToken(token), userId, csrfToken, expiresAt],
      )
      return { token, csrfToken }
    },

    async find(token: string, now: Date) {
      const { rows } = await pool.query<UserRow & { csrf_token: string; expires_at: Date }>(
        `SELECT ${USER_COLUMNS}, s.csrf_token, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [hashToken(token), now],
      )
      const row = rows[0]
      return row
        ? { user: toUser(row), csrfToken: row.csrf_token, expiresAt: row.expires_at }
        : null
    },

    async revoke(token: string) {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
    },
  }
}

export function createLoginAttemptStore(pool: pg.Pool): LoginAttemptStore {
  return {
    async save(attempt: LoginAttempt, expiresAt: Date) {
      const id = newToken()
      await pool.query(
        `INSERT INTO login_attempts (id_hash, code_verifier, state, nonce, return_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          hashToken(id),
          attempt.codeVerifier,
          attempt.state,
          attempt.nonce,
          attempt.returnTo,
          expiresAt,
        ],
      )
      return id
    },

    async take(id: string, now: Date) {
      const { rows } = await pool.query<{
        code_verifier: string
        state: string
        nonce: string
        return_to: string
        expires_at: Date
      }>(
        `DELETE FROM login_attempts WHERE id_hash = $1
         RETURNING code_verifier, state, nonce, return_to, expires_at`,
        [hashToken(id)],
      )
      const row = rows[0]
      if (!row || row.expires_at <= now) return null
      return {
        codeVerifier: row.code_verifier,
        state: row.state,
        nonce: row.nonce,
        returnTo: row.return_to,
      }
    },
  }
}
