import { createPingHandler } from '@octobrief/application'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConsoleLogger } from '../src/logging/console-logger.ts'
import { createDatabaseProbe, createPool } from '../src/postgres/pool.ts'
import { installQueue } from '../src/queue/install-queue.ts'
import {
  ALREADY_QUEUED,
  openPgBossQueue,
  type PgBossQueue,
  toJobStatus,
} from '../src/queue/pg-boss-queue.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)
const silent = createConsoleLogger('test', () => {})

describe('toJobStatus', () => {
  it('maps every pg-boss state', () => {
    expect(toJobStatus('created')).toBe('queued')
    expect(toJobStatus('retry')).toBe('queued')
    expect(toJobStatus('active')).toBe('running')
    expect(toJobStatus('completed')).toBe('completed')
    expect(toJobStatus('failed')).toBe('failed')
    expect(toJobStatus('cancelled')).toBe('failed')
  })
})

describe.skipIf(!hasDatabase)('queue on Postgres (integration)', () => {
  let web: PgBossQueue
  let worker: PgBossQueue

  beforeAll(async () => {
    await installQueue(DATABASE_OWNER_URL as string)
    web = await openPgBossQueue(DATABASE_URL as string, { supervise: false, logger: silent })
    worker = await openPgBossQueue(DATABASE_WORKER_URL as string, {
      supervise: true,
      logger: silent,
    })
  })

  afterAll(async () => {
    await Promise.all([web?.stop(), worker?.stop()])
  })

  it('reports the queue as installed', async () => {
    expect(await web.probe.check()).toBe(true)
  })

  it('carries a ping from the web role to the worker role', async () => {
    const jobId = await web.enqueue('system.ping', { requestedAt: new Date().toISOString() })
    expect(await web.status('system.ping', jobId)).toBe('queued')

    await worker.work('system.ping', createPingHandler(silent))
    await expect
      .poll(() => web.status('system.ping', jobId), { timeout: 15_000, interval: 250 })
      .toBe('completed')
  })

  it('queues one read of a source at a time: asked again at once, nothing is added', async () => {
    const sourceId = crypto.randomUUID()
    const first = await web.enqueue('source.sync', { sourceId })
    const second = await web.enqueue('source.sync', { sourceId })
    const other = await web.enqueue('source.sync', { sourceId: crypto.randomUUID() })
    expect(await web.status('source.sync', first)).toBe('queued')
    expect(second).toBe(`${ALREADY_QUEUED}:${sourceId}`)
    expect(other).not.toContain(ALREADY_QUEUED)

    // Once the worker has taken the read, «read now» queues another one.
    let taken = 0
    await worker.work('source.sync', async () => {
      taken++
    })
    await expect.poll(() => taken, { timeout: 15_000, interval: 250 }).toBeGreaterThanOrEqual(2)
    const again = await web.enqueue('source.sync', { sourceId })
    expect(again).not.toContain(ALREADY_QUEUED)
  })

  it('answers null for an unknown job', async () => {
    expect(await web.status('system.ping', crypto.randomUUID())).toBeNull()
  })

  it('probes the database as the app role', async () => {
    const pool = createPool(DATABASE_URL as string, 'octobrief-test', 1)
    try {
      expect(await createDatabaseProbe(pool).check()).toBe(true)
    } finally {
      await pool.end()
    }
  })
})
