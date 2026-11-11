import type { HealthProbe } from '@octobrief/application'
import pg from 'pg'

export function createPool(databaseUrl: string, applicationName: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, application_name: applicationName, max })
}

export function createDatabaseProbe(pool: pg.Pool): HealthProbe {
  return {
    name: 'database',
    async check() {
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok')
      return rows[0]?.ok === 1
    },
  }
}
