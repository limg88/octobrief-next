import type { JobHandler, JobName, JobWorker, Logger } from '@octobrief/application'
import { describe, expect, it } from 'vitest'
import { startWorker } from '../src/worker.ts'

class FakeWorkerQueue implements JobWorker {
  readonly handlers = new Map<JobName, JobHandler<JobName>>()
  stopped = false
  async work<N extends JobName>(name: N, handler: JobHandler<N>): Promise<void> {
    this.handlers.set(name, handler as JobHandler<JobName>)
  }
  async stop(): Promise<void> {
    this.stopped = true
  }
}

const messages: string[] = []
const logger: Logger = { info: (m) => messages.push(m), error: (m) => messages.push(m) }

describe('startWorker', () => {
  it('registers the ping handler and stops cleanly', async () => {
    const queue = new FakeWorkerQueue()
    const stop = await startWorker({ queue, logger })
    expect([...queue.handlers.keys()]).toEqual(['system.ping'])

    await queue.handlers.get('system.ping')?.({ requestedAt: '2026-11-11T10:00:00.000Z' }, 'job-1')
    await stop()

    expect(queue.stopped).toBe(true)
    expect(messages).toEqual(['worker started', 'ping received', 'worker stopped'])
  })
})
