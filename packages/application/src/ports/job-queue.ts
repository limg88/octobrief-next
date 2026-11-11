import type { JobStatus } from '@octobrief/domain'
import type { JobData, JobName } from '../jobs.ts'

/** Sends jobs and reports on them. Used by the web side, which never runs a job itself. */
export interface JobQueue {
  /** Validates the payload, queues the job and returns its id. */
  enqueue<N extends JobName>(name: N, data: JobData[N]): Promise<string>
  /** The job's status, or null when no job of that name has this id. */
  status(name: JobName, id: string): Promise<JobStatus | null>
}

export type JobHandler<N extends JobName> = (data: JobData[N], jobId: string) => Promise<void>

/** Takes jobs and runs their handlers. Used by the worker only. */
export interface JobWorker {
  work<N extends JobName>(name: N, handler: JobHandler<N>): Promise<void>
  stop(): Promise<void>
}
