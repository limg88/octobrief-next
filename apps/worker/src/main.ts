// Composition root of the worker process.
import type { AskReading } from '@octobrief/application'
import {
  answerStore,
  createConnectorFeeds,
  createConsoleLogger,
  createDocumentProcessingStore,
  createExternalItemStore,
  createFileBlobStore,
  createKnowledgeStore,
  createModelRunner,
  createPool,
  createQuestionWorkStore,
  createSecretVault,
  createSourceSyncStore,
  inTransaction,
  knowledgeReader,
  loadWorkerConfig,
  openPgBossQueue,
  trackerReader,
} from '@octobrief/infrastructure'
import { createIsolatedExtractor } from '@octobrief/infrastructure/extract'
import { startWorker } from './worker.ts'

const logger = createConsoleLogger('worker')
const config = loadWorkerConfig()
const queue = await openPgBossQueue(config.databaseUrl, { supervise: true, logger })
const pool = createPool(config.databaseUrl, 'octobrief-worker')
const knowledge = createKnowledgeStore(pool)
// Every read of a question runs in a short transaction of its own, always naming the project.
const reading: AskReading<unknown> = {
  reader: knowledgeReader,
  store: answerStore,
  tracker: trackerReader,
  withTx: (fn) => inTransaction(pool, fn),
} as AskReading<unknown>
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
  asking: { questions: createQuestionWorkStore(pool), reading },
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
