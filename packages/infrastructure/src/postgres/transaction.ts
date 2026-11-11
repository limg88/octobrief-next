import type pg from 'pg'

/** Runs `work` in a transaction on one pooled connection. */
export async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Runs `work` in a transaction where row-level security sees `viewerId` as the signed-in person
 * (`app.user_id`, local to the transaction so a pooled connection never keeps it).
 */
export function asViewer<T>(
  pool: pg.Pool,
  viewerId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, async (client) => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [viewerId])
    return work(client)
  })
}
