import type { JobName } from '@octobrief/application'

/** The Postgres schema that holds the queue tables. */
export const QUEUE_SCHEMA = 'pgboss'

/** Roles that use the queue at run time: the web sends jobs, the worker takes them. */
export const QUEUE_ROLES = ['octobrief_app', 'octobrief_worker'] as const

export interface QueueSettings {
  readonly retryLimit: number
  readonly retryDelay: number
  readonly expireInSeconds: number
}

export const QUEUE_SETTINGS: Record<JobName, QueueSettings> = {
  'system.ping': { retryLimit: 1, retryDelay: 1, expireInSeconds: 60 },
  // Extraction runs in a child stopped after 60 s; a retry covers a worker restart.
  'document.process': { retryLimit: 2, retryDelay: 10, expireInSeconds: 300 },
  // Model calls of a whole document: slow backends take minutes; a retry covers a busy gateway.
  'document.compile': { retryLimit: 2, retryDelay: 30, expireInSeconds: 1800 },
  // A failed read is recorded on the source; the next scheduled run tries again.
  'source.sync': { retryLimit: 0, retryDelay: 1, expireInSeconds: 1800 },
  // A failed answer is recorded on the question: the PM asks again.
  'question.answer': { retryLimit: 0, retryDelay: 1, expireInSeconds: 900 },
}
