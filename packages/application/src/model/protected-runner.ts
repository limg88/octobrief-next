import type { KnownPerson, ProjectId } from '@octobrief/domain'
import type { ModelRunner } from '../ports/model-runner.ts'
import { type GuardOptions, guardedRunner } from './guarded-runner.ts'
import { pseudonymizingRunner } from './pseudonymizing-runner.ts'

export interface ProtectionOptions extends GuardOptions {
  /** People and organizations of a project whose names must never reach the model. */
  people(projectId: ProjectId): Promise<KnownPerson[]>
}

/**
 * The only way a model adapter is used: `guarded(pseudonymizing(adapter))`, for `run` and `embed`
 * alike. The guard decides first, so nothing starts for a refused project; pseudonymization is
 * the last step before the adapter.
 */
export function protectedRunner(adapter: ModelRunner, options: ProtectionOptions): ModelRunner {
  return guardedRunner(pseudonymizingRunner(adapter, options.people), {
    resolveProject: options.resolveProject,
    allowedForReal: options.allowedForReal,
  })
}
