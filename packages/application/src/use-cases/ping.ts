import type { JobStatus } from '@octobrief/domain'
import type { JobQueue } from '../ports/job-queue.ts'
import type { Logger } from '../ports/logger.ts'

/**
 * The ping job proves the web → queue → worker round trip. It does no work of its own.
 */
export async function requestPing(queue: JobQueue, now: () => Date = () => new Date()) {
  const jobId = await queue.enqueue('system.ping', { requestedAt: now().toISOString() })
  return { jobId }
}

export function getPingStatus(queue: JobQueue, jobId: string): Promise<JobStatus | null> {
  return queue.status('system.ping', jobId)
}

export function createPingHandler(logger: Logger) {
  return async (data: { requestedAt: string }, jobId: string): Promise<void> => {
    logger.info('ping received', { jobId, requestedAt: data.requestedAt })
  }
}
