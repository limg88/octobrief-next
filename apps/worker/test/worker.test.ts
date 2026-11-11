import type { JobHandler, JobName, JobWorker, Logger } from '@octobrief/application'
import {
  FakeExtractor,
  InMemoryBlobs,
  InMemoryDocuments,
  InMemoryProjects,
  InMemoryUsers,
} from '@octobrief/application/testing'
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

function setup(store: InMemoryDocuments) {
  const messages: string[] = []
  const logger: Logger = { info: (m) => messages.push(m), error: (m) => messages.push(m) }
  const queue = new FakeWorkerQueue()
  const deps = {
    queue,
    logger,
    store,
    blobs: new InMemoryBlobs(),
    extractor: new FakeExtractor(() => ({
      extractor: 'test/1',
      chunks: [],
      truncated: false,
      metadataDate: null,
      warnings: [],
    })),
    retentionDays: 30,
    now: () => new Date('2026-11-11T10:00:00Z'),
  }
  return { deps, queue, messages }
}

describe('startWorker', () => {
  it('registers the job handlers, purges at start and stops cleanly', async () => {
    const users = new InMemoryUsers()
    const { deps, queue, messages } = setup(
      new InMemoryDocuments(new InMemoryProjects(users), users),
    )
    const stop = await startWorker(deps)
    expect([...queue.handlers.keys()]).toEqual(['system.ping', 'document.process'])

    await queue.handlers.get('system.ping')?.({ requestedAt: '2026-11-11T10:00:00.000Z' }, 'job-1')
    await stop()

    expect(queue.stopped).toBe(true)
    expect(messages).toEqual(['worker started', 'ping received', 'worker stopped'])
  })

  it('logs a failed purge without stopping', async () => {
    const users = new InMemoryUsers()
    const store = new InMemoryDocuments(new InMemoryProjects(users), users)
    store.expired = async () => {
      throw new Error('database down')
    }
    const { deps, messages } = setup(store)
    const stop = await startWorker(deps)
    await new Promise((resolve) => setImmediate(resolve))
    await stop()
    expect(messages).toContain('document purge failed')
  })
})
