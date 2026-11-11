import {
  type HealthProbe,
  JOB_NAMES,
  JOB_SCHEMAS,
  type JobHandler,
  type JobName,
  type JobQueue,
  type JobWorker,
  type Logger,
} from '@octobrief/application'
import type { JobStatus } from '@octobrief/domain'
import { PgBoss } from 'pg-boss'
import { QUEUE_SCHEMA } from './settings.ts'

type BossState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed'

const STATUS_BY_STATE: Record<BossState, JobStatus> = {
  created: 'queued',
  retry: 'queued',
  active: 'running',
  completed: 'completed',
  cancelled: 'failed',
  failed: 'failed',
}

export function toJobStatus(state: BossState): JobStatus {
  return STATUS_BY_STATE[state]
}

export interface PgBossQueueOptions {
  /** Only the worker runs maintenance (expiring stalled jobs, retention). */
  readonly supervise: boolean
  readonly logger: Logger
  readonly maxConnections?: number
}

export type PgBossQueue = JobQueue & JobWorker & { readonly probe: HealthProbe }

/**
 * Opens the queue as a runtime role. The schema is installed by the owner (`installQueue`), so
 * pg-boss here neither creates nor migrates anything.
 */
export async function openPgBossQueue(
  databaseUrl: string,
  options: PgBossQueueOptions,
): Promise<PgBossQueue> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: QUEUE_SCHEMA,
    application_name: 'octobrief-queue',
    max: options.maxConnections ?? 4,
    migrate: false,
    createSchema: false,
    supervise: options.supervise,
    schedule: false,
    registerInstance: false,
    persistWarnings: false,
    reindex: false,
  })
  // Name and driver code only: messages may echo connection details.
  boss.on('error', (error) =>
    options.logger.error('queue error', { error: error.name, code: errorCode(error) }),
  )
  await boss.start()

  return {
    async enqueue(name, data) {
      const id = await boss.send(name, JOB_SCHEMAS[name].parse(data))
      if (id === null) throw new Error(`queue refused a ${name} job`)
      return id
    },
    async status(name, id) {
      const job = await boss.getJobById(name, id)
      return job ? toJobStatus(job.state) : null
    },
    async work<N extends JobName>(name: N, handler: JobHandler<N>) {
      await boss.work(name, async ([job]) => {
        if (!job) return
        // A payload that does not parse fails the job: retrying cannot fix it.
        await handler(JOB_SCHEMAS[name].parse(job.data) as Parameters<JobHandler<N>>[0], job.id)
      })
    },
    async stop() {
      await boss.stop({ graceful: true, close: true })
    },
    probe: {
      name: 'queue',
      async check() {
        const queues = await Promise.all(JOB_NAMES.map((name) => boss.getQueue(name)))
        return queues.every((queue) => queue !== null)
      },
    },
  }
}

function errorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
