import { describe, expect, it } from 'vitest'
import { createPingHandler, getPingStatus, requestPing } from '../src/use-cases/ping.ts'
import { InMemoryJobQueue, RecordingLogger } from './fakes.ts'

describe('ping', () => {
  it('queues a ping job stamped with the request time', async () => {
    const queue = new InMemoryJobQueue()
    const { jobId } = await requestPing(queue, () => new Date('2026-11-11T10:00:00Z'))
    expect(queue.jobs.get(jobId)).toEqual({
      name: 'system.ping',
      data: { requestedAt: '2026-11-11T10:00:00.000Z' },
      status: 'queued',
    })
  })

  it('reads the status of a ping job', async () => {
    const queue = new InMemoryJobQueue()
    const { jobId } = await requestPing(queue)
    expect(await getPingStatus(queue, jobId)).toBe('queued')
    expect(await getPingStatus(queue, 'missing')).toBeNull()
  })

  it('logs the ping when the worker handles it', async () => {
    const logger = new RecordingLogger()
    await createPingHandler(logger)({ requestedAt: '2026-11-11T10:00:00.000Z' }, 'job-1')
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'ping received',
        fields: { jobId: 'job-1', requestedAt: '2026-11-11T10:00:00.000Z' },
      },
    ])
  })
})
