import { createPingHandler, type JobWorker, type Logger } from '@octobrief/application'

export interface WorkerDependencies {
  readonly queue: JobWorker
  readonly logger: Logger
}

/** Registers every job handler. Returns a function that stops taking jobs and drains. */
export async function startWorker({
  queue,
  logger,
}: WorkerDependencies): Promise<() => Promise<void>> {
  await queue.work('system.ping', createPingHandler(logger))
  logger.info('worker started')
  return async () => {
    await queue.stop()
    logger.info('worker stopped')
  }
}
