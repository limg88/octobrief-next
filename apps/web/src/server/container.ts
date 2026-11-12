import 'server-only'
import { type Api, type ApiDependencies, createApi } from '@octobrief/api'
import {
  createConnectorFeeds,
  createConsoleLogger,
  createDatabaseProbe,
  createDocumentRepository,
  createExternalItemStore,
  createFactRepository,
  createFileBlobStore,
  createFileRecipeLibrary,
  createLoginAttemptStore,
  createOidcIdentityProvider,
  createPool,
  createProjectRepository,
  createQuestionRepository,
  createRunRepository,
  createSecretVault,
  createSessionStore,
  createSourceRepository,
  createUserRepository,
  loadWebConfig,
  openPgBossQueue,
} from '@octobrief/infrastructure'

// Composition root of the web process: the only place that knows the adapters.

export interface WebContainer {
  readonly api: Api
  readonly deps: ApiDependencies
}

const CALLBACK_PATH = '/api/auth/callback'

async function build(): Promise<WebContainer> {
  const config = loadWebConfig()
  const logger = createConsoleLogger('web')
  const pool = createPool(config.databaseUrl, 'octobrief-web')
  const queue = await openPgBossQueue(config.databaseUrl, { supervise: false, logger })
  const deps: ApiDependencies = {
    probes: [createDatabaseProbe(pool), queue.probe],
    queue,
    identity: createOidcIdentityProvider({
      ...config.oidc,
      callbackUrl: new URL(CALLBACK_PATH, config.publicUrl).toString(),
      postLogoutUrl: new URL('/login', config.publicUrl).toString(),
    }),
    users: createUserRepository(pool),
    sessions: createSessionStore(pool),
    loginAttempts: createLoginAttemptStore(pool),
    projects: createProjectRepository(pool),
    documents: createDocumentRepository(pool),
    facts: createFactRepository(pool),
    questions: createQuestionRepository(pool),
    library: createFileRecipeLibrary(config.recipesDir),
    runs: createRunRepository(pool),
    sources: createSourceRepository(pool),
    items: createExternalItemStore(pool, { asCreator: true }),
    feeds: createConnectorFeeds({ logger, devEndpoints: config.sources.devEndpoints }),
    vault: createSecretVault(config.sources.secretsKey),
    blobs: createFileBlobStore(config.blobDir),
    adminEmails: config.adminEmails,
    logger,
    publicUrl: config.publicUrl,
    secureCookies: config.secureCookies,
    now: () => new Date(),
  }
  return { api: createApi(deps), deps }
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
