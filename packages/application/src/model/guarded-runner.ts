import {
  assertBackendAllowed,
  type BackendId,
  type DataNature,
  DomainError,
  type ProjectId,
} from '@octobrief/domain'
import { ModelError, type ModelRunner } from '../ports/model-runner.ts'

export interface GuardOptions {
  /** The stored data nature of a project: the guard never trusts a value carried by the request. */
  resolveProject(projectId: ProjectId): Promise<{ dataNature: DataNature }>
  /** Backends the organisation allows for projects with real data. */
  allowedForReal(): Promise<readonly BackendId[]>
}

/**
 * Refuses, before any call, a backend not allowed for the project's data nature. The data nature
 * is looked up for the request's project at every run and every embedding call; an embedding is
 * checked against the backend of the encoder, not the one of the chat model. If a lookup throws,
 * the error propagates and the inner runner is never called (fail closed); anything but
 * `synthetic` counts as real.
 */
export function guardedRunner(inner: ModelRunner, opts: GuardOptions): ModelRunner {
  const check = async (projectId: ProjectId, backend: BackendId) => {
    const { dataNature } = await opts.resolveProject(projectId)
    const allowed = await opts.allowedForReal()
    try {
      assertBackendAllowed(
        { dataNature: dataNature === 'synthetic' ? 'synthetic' : 'real' },
        backend,
        allowed,
      )
    } catch (e) {
      if (e instanceof DomainError) {
        throw new ModelError('not_allowed', 'backend not allowed for this project')
      }
      throw e
    }
  }
  const guarded: ModelRunner = {
    backend: inner.backend,
    async run(req, signal) {
      await check(req.context.projectId, inner.backend)
      return inner.run(req, signal)
    },
  }
  const { embedding, embed } = inner
  if (!embedding || !embed) return guarded
  return {
    ...guarded,
    embedding,
    async embed(req, signal) {
      await check(req.context.projectId, embedding.backend)
      return embed.call(inner, req, signal)
    },
  }
}
