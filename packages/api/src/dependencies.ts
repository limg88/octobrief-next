import type {
  AuthDependencies,
  HealthProbe,
  JobQueue,
  Logger,
  ProjectRepository,
} from '@octobrief/application'

/** What the HTTP interface needs from the outside world; wired by the composition root. */
export interface ApiDependencies extends AuthDependencies {
  readonly probes: readonly HealthProbe[]
  readonly queue: JobQueue
  readonly projects: ProjectRepository
  readonly logger: Logger
  /** Public origin of the web app, e.g. `https://octobrief.example.com`. */
  readonly publicUrl: string
  readonly secureCookies: boolean
}
