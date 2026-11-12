import {
  createCompileDocumentHandler,
  createPingHandler,
  createProcessDocumentHandler,
  createPurgeDocumentsHandler,
  createScheduleSyncHandler,
  createSyncSourceHandler,
  type JobWorker,
  type KnowledgeStore,
  type Logger,
  type ModelRunner,
  type ProcessingDependencies,
  type SyncDependencies,
} from '@octobrief/application'
import { retentionCutoff } from '@octobrief/domain'

/** How often expired documents are purged; the first run happens at start. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000

export interface WorkerDependencies extends Omit<ProcessingDependencies, 'logger'> {
  readonly queue: JobWorker
  readonly knowledge: KnowledgeStore
  /** Already protected: guarded and pseudonymizing. */
  readonly runner: ModelRunner
  readonly logger: Logger
  readonly retentionDays: number
  /** What reading Jira and Azure DevOps needs, and how often it happens. */
  readonly sources: Omit<SyncDependencies, 'blobs' | 'jobs' | 'logger'>
  readonly syncIntervalMs: number
  readonly now?: () => Date
}

/** Registers every job handler and the retention timer. Returns a function that drains and stops. */
export async function startWorker(deps: WorkerDependencies): Promise<() => Promise<void>> {
  const { queue, logger } = deps
  await queue.work('system.ping', createPingHandler(logger))
  await queue.work('document.process', createProcessDocumentHandler(deps))
  await queue.work(
    'document.compile',
    createCompileDocumentHandler({ knowledge: deps.knowledge, runner: deps.runner, logger }),
  )
  await queue.work(
    'source.sync',
    createSyncSourceHandler({ ...deps.sources, blobs: deps.blobs, jobs: deps.jobs, logger }),
  )
  const scheduleSync = createScheduleSyncHandler({ sync: deps.sources.sync, jobs: deps.jobs })
  const runSync = () => {
    scheduleSync().catch((error: unknown) =>
      logger.error('source sync scheduling failed', { error: (error as Error).name }),
    )
  }
  const purge = createPurgeDocumentsHandler({
    store: deps.store,
    blobs: deps.blobs,
    logger,
    now: deps.now ?? (() => new Date()),
    retentionCutoff: (now) => retentionCutoff(now, deps.retentionDays),
  })
  const runPurge = () => {
    purge().catch((error: unknown) =>
      logger.error('document purge failed', { error: (error as Error).name }),
    )
  }
  runPurge()
  const timer = setInterval(runPurge, PURGE_INTERVAL_MS)
  timer.unref()
  runSync()
  const syncTimer = setInterval(runSync, deps.syncIntervalMs)
  syncTimer.unref()
  logger.info('worker started')
  return async () => {
    clearInterval(timer)
    clearInterval(syncTimer)
    await queue.stop()
    logger.info('worker stopped')
  }
}
