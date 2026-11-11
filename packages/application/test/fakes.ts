import type { JobStatus } from '@octobrief/domain'
import type { JobData, JobName } from '../src/jobs.ts'
import { JOB_SCHEMAS } from '../src/jobs.ts'
import type { JobQueue } from '../src/ports/job-queue.ts'
import type { Logger } from '../src/ports/logger.ts'

export class InMemoryJobQueue implements JobQueue {
  readonly jobs = new Map<string, { name: JobName; data: unknown; status: JobStatus }>()
  private nextId = 1

  async enqueue<N extends JobName>(name: N, data: JobData[N]): Promise<string> {
    const parsed = JOB_SCHEMAS[name].parse(data)
    const id = `job-${this.nextId++}`
    this.jobs.set(id, { name, data: parsed, status: 'queued' })
    return id
  }

  async status(name: JobName, id: string): Promise<JobStatus | null> {
    const job = this.jobs.get(id)
    return job && job.name === name ? job.status : null
  }
}

export class RecordingLogger implements Logger {
  readonly entries: { level: 'info' | 'error'; message: string; fields?: unknown }[] = []
  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, fields })
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, fields })
  }
}
