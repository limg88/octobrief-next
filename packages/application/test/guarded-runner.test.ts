import { type DataNature, newId, type ProjectId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { guardedRunner } from '../src/model/guarded-runner.ts'
import { ModelError, type ModelRequest, type ModelResponse } from '../src/ports/model-runner.ts'
import { fakeModelRunner } from './fake-model-runner.ts'

const reply: ModelResponse = {
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
  backend: 'fake',
}
const projectId = newId<ProjectId>()
const req = (): ModelRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  context: { projectId },
})
const project = (dataNature: DataNature) => async () => ({ dataNature })

describe('guardedRunner', () => {
  it('refuses a real project on a backend not allowed, without calling the inner runner', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: project('real'),
      allowedForReal: async () => [],
    })
    await expect(g.run(req())).rejects.toMatchObject({
      kind: 'not_allowed',
      name: 'ModelError',
    })
    expect(inner.requests).toHaveLength(0)
  })

  it('passes a synthetic project', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: project('synthetic'),
      allowedForReal: async () => [],
    })
    await expect(g.run(req())).resolves.toEqual(reply)
    expect(inner.requests).toHaveLength(1)
  })

  it('passes a real project on an allowed backend', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: project('real'),
      allowedForReal: async () => ['fake'],
    })
    await expect(g.run(req())).resolves.toEqual(reply)
  })

  it('asks the resolver for the data nature of the request project', async () => {
    const asked: ProjectId[] = []
    const g = guardedRunner(fakeModelRunner([reply]), {
      resolveProject: async (id) => {
        asked.push(id)
        return { dataNature: 'synthetic' }
      },
      allowedForReal: async () => [],
    })
    await g.run(req())
    expect(asked).toEqual([projectId])
  })

  it('treats an unrecognized data nature as real', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: async () => ({ dataNature: 'unknown' as DataNature }),
      allowedForReal: async () => [],
    })
    await expect(g.run(req())).rejects.toMatchObject({ kind: 'not_allowed' })
    expect(inner.requests).toHaveLength(0)
  })

  it('fails closed when the project cannot be resolved', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: async () => {
        throw new Error('db down')
      },
      allowedForReal: async () => ['fake'],
    })
    const err = await g.run(req()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(inner.requests).toHaveLength(0)
  })

  it('does not swallow unexpected errors from the allow-list lookup', async () => {
    const inner = fakeModelRunner([reply])
    const g = guardedRunner(inner, {
      resolveProject: project('real'),
      allowedForReal: async () => {
        throw new Error('db down')
      },
    })
    const err = await g.run(req()).catch((e) => e)
    expect(err).not.toBeInstanceOf(ModelError)
    expect(err.message).toBe('db down')
    expect(inner.requests).toHaveLength(0)
  })
})
