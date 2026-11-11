import 'server-only'
import { type Api, createApi } from '@octobrief/api'
import type { HealthProbe } from '@octobrief/application'
import {
  createConsoleLogger,
  createDatabaseProbe,
  createPool,
  loadWebConfig,
  openPgBossQueue,
} from '@octobrief/infrastructure'

// Composition root of the web process: the only place that knows the adapters.

export interface WebContainer {
  readonly api: Api
  readonly probes: readonly HealthProbe[]
}

async function build(): Promise<WebContainer> {
  const config = loadWebConfig()
  const logger = createConsoleLogger('web')
  const pool = createPool(config.databaseUrl, 'octobrief-web')
  const queue = await openPgBossQueue(config.databaseUrl, { supervise: false, logger })
  const probes = [createDatabaseProbe(pool), queue.probe]
  return { api: createApi({ probes, queue }), probes }
}

// One container per process, kept across dev hot reloads.
const holder = globalThis as typeof globalThis & {
  __octobriefContainer?: Promise<WebContainer> | undefined
}

export function getContainer(): Promise<WebContainer> {
  holder.__octobriefContainer ??= build().catch((error: unknown) => {
    holder.__octobriefContainer = undefined
    throw error
  })
  return holder.__octobriefContainer
}
