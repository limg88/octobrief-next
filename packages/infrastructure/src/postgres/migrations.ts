import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url))
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
// Serializes concurrent runs (two terminals, CI retries).
const ADVISORY_LOCK_KEY = 4_215_001

/**
 * Applies the pending `NNNN_name.sql` files in order, each in its own transaction, and records
 * them in `schema_migrations`. Runs as the database owner. Returns the names applied now.
 */
export async function runMigrations(
  ownerUrl: string,
  directory: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => MIGRATION_FILE.test(name)).sort()
  const client = new pg.Client({
    connectionString: ownerUrl,
    application_name: 'octobrief-migrate',
  })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
    const done = new Set(rows.map((row) => row.name))
    const applied: string[] = []
    for (const name of files.filter((file) => !done.has(file))) {
      const sql = await readFile(join(directory, name), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${name} failed`, { cause: error })
      }
      applied.push(name)
    }
    return applied
  } finally {
    await client.end()
  }
}
