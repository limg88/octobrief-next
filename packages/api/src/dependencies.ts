import type { HealthProbe, JobQueue } from '@octobrief/application'

/** What the HTTP interface needs from the outside world; wired by the composition root. */
export interface ApiDependencies {
  readonly probes: readonly HealthProbe[]
  readonly queue: JobQueue
}
