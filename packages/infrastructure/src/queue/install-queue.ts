import { JOB_NAMES } from '@octobrief/application'
import pg from 'pg'
import { PgBoss } from 'pg-boss'
import { QUEUE_ROLES, QUEUE_SCHEMA, QUEUE_SETTINGS } from './settings.ts'

/**
 * Installs or migrates the queue schema and its queues, then grants the runtime roles what pg-boss
 * needs and nothing more. `ownerUrl` must connect as the database owner. Safe to run again.
 */
export async function installQueue(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: QUEUE_SCHEMA,
    application_name: 'octobrief-queue-install',
    max: 2,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
  })
  let failure: unknown
  boss.on('error', (error) => {
    failure ??= error
  })
  await boss.start()
  try {
    for (const name of JOB_NAMES) {
      const settings = QUEUE_SETTINGS[name]
      if (await boss.getQueue(name)) await boss.updateQueue(name, settings)
      else await boss.createQueue(name, settings)
    }
  } finally {
    await boss.stop({ graceful: false, close: true })
  }
  if (failure) throw failure
  await grantRuntimeRoles(ownerUrl)
}

async function grantRuntimeRoles(ownerUrl: string): Promise<void> {
  const roles = QUEUE_ROLES.join(', ')
  const client = new pg.Client({ connectionString: ownerUrl })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query(`GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO ${roles}`)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO ${roles}`,
    )
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO ${roles}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}
