// Composition root of the worker process.
import { createConsoleLogger, loadWorkerConfig, openPgBossQueue } from '@octobrief/infrastructure'
import { startWorker } from './worker.ts'

const logger = createConsoleLogger('worker')
const config = loadWorkerConfig()
const queue = await openPgBossQueue(config.databaseUrl, { supervise: true, logger })
const stop = await startWorker({ queue, logger })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
