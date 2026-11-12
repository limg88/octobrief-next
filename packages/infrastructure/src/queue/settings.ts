import type { JobName } from '@octobrief/application'

/** The Postgres schema that holds the queue tables. */
export const QUEUE_SCHEMA = 'pgboss'

/** Roles that use the queue at run time: the web sends jobs, the worker takes them. */
export const QUEUE_ROLES = ['octobrief_app', 'octobrief_worker'] as const

export interface QueueSettings {
  readonly retryLimit: number
  readonly retryDelay: number
  readonly expireInSeconds: number
  /** How long a job may wait to be taken before it is dropped; the queue's default when absent. */
  readonly retentionSeconds?: number
}

/**
 * Jobs that are the same work when they name the same thing: only one of them is queued within
 * the window, the others are not added (a source is not read twice in a row because the
 * scheduler and the PM both asked).
 */
export const SINGLETON_JOBS: Partial<Record<JobName, { field: string; seconds: number }>> = {
  'source.sync': { field: 'sourceId', seconds: 60 },
}

export const QUEUE_SETTINGS: Record<JobName, QueueSettings> = {
  'system.ping': { retryLimit: 1, retryDelay: 1, expireInSeconds: 60 },
  // Extraction runs in a child stopped after 60 s; a retry covers a worker restart.
  'document.process': { retryLimit: 2, retryDelay: 10, expireInSeconds: 300 },
  // Model calls of a whole document: slow backends take minutes; a retry covers a busy gateway.
  'document.compile': { retryLimit: 2, retryDelay: 30, expireInSeconds: 1800 },
  // A failed read is recorded on the source; the next scheduled run tries again.
  // A read left waiting for half an hour (the worker was down) is dropped: the next schedule asks again.
  'source.sync': { retryLimit: 0, retryDelay: 1, expireInSeconds: 1800, retentionSeconds: 1800 },
  // A failed answer is recorded on the question: the PM asks again.
  'question.answer': { retryLimit: 0, retryDelay: 1, expireInSeconds: 900 },
  // A failed run, revision or render is recorded on the run: the PM decides what to do next.
  'deliverable.run': { retryLimit: 0, retryDelay: 1, expireInSeconds: 3600 },
  'deliverable.revise': { retryLimit: 0, retryDelay: 1, expireInSeconds: 1800 },
  'deliverable.render': { retryLimit: 1, retryDelay: 10, expireInSeconds: 600 },
}
