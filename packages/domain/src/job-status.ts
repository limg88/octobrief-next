/** Lifecycle of a background job as the product sees it, whatever the queue technology. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'completed', 'failed']

export function isFinished(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed'
}
