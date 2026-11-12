import type {
  AuthDependencies,
  BlobStore,
  DocumentRepository,
  ExternalItemStore,
  FactRepository,
  HealthProbe,
  JobQueue,
  Logger,
  ProjectRepository,
  SecretVault,
  SourceFeeds,
  SourceRepository,
} from '@octobrief/application'

/** What the HTTP interface needs from the outside world; wired by the composition root. */
export interface ApiDependencies extends AuthDependencies {
  readonly probes: readonly HealthProbe[]
  readonly queue: JobQueue
  readonly projects: ProjectRepository
  readonly documents: DocumentRepository
  readonly facts: FactRepository
  readonly sources: SourceRepository
  /** Stores a feeder's delivery as the person who connected its source. */
  readonly items: ExternalItemStore
  readonly feeds: SourceFeeds
  readonly vault: SecretVault
  readonly blobs: BlobStore
  readonly logger: Logger
  /** Public origin of the web app, e.g. `https://octobrief.example.com`. */
  readonly publicUrl: string
  readonly secureCookies: boolean
}
