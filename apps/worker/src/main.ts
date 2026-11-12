// Composition root of the worker process.
import {
  createConnectorFeeds,
  createConsoleLogger,
  createDocumentProcessingStore,
  createExternalItemStore,
  createFileBlobStore,
  createKnowledgeStore,
  createModelRunner,
  createPool,
  createSecretVault,
  createSourceSyncStore,
  loadWorkerConfig,
  openPgBossQueue,
} from '@octobrief/infrastructure'
import { createIsolatedExtractor } from '@octobrief/infrastructure/extract'
import { startWorker } from './worker.ts'

const logger = createConsoleLogger('worker')
const config = loadWorkerConfig()
const queue = await openPgBossQueue(config.databaseUrl, { supervise: true, logger })
const pool = createPool(config.databaseUrl, 'octobrief-worker')
const knowledge = createKnowledgeStore(pool)
const stop = await startWorker({
  queue,
  jobs: queue,
  logger,
  knowledge,
  runner: createModelRunner(config.model, (projectId) => knowledge.people(projectId)),
  store: createDocumentProcessingStore(pool),
  blobs: createFileBlobStore(config.blobDir),
  extractor: createIsolatedExtractor(),
  retentionDays: config.retentionDays,
  syncIntervalMs: config.syncIntervalMinutes * 60_000,
  sources: {
    sync: createSourceSyncStore(pool),
    items: createExternalItemStore(pool, { asCreator: false }),
    feeds: createConnectorFeeds({ logger, devEndpoints: config.sources.devEndpoints }),
    vault: createSecretVault(config.sources.secretsKey),
  },
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
