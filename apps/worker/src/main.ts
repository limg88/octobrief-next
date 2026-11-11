// Composition root of the worker process.
import {
  createConsoleLogger,
  createDocumentProcessingStore,
  createFileBlobStore,
  createPool,
  loadWorkerConfig,
  openPgBossQueue,
} from '@octobrief/infrastructure'
import { createIsolatedExtractor } from '@octobrief/infrastructure/extract'
import { startWorker } from './worker.ts'

const logger = createConsoleLogger('worker')
const config = loadWorkerConfig()
const queue = await openPgBossQueue(config.databaseUrl, { supervise: true, logger })
const pool = createPool(config.databaseUrl, 'octobrief-worker')
const stop = await startWorker({
  queue,
  logger,
  store: createDocumentProcessingStore(pool),
  blobs: createFileBlobStore(config.blobDir),
  extractor: createIsolatedExtractor(),
  retentionDays: config.retentionDays,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop()
      .then(() => pool.end())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      )
  })
}
