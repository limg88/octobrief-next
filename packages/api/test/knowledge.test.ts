import type { InMemoryKnowledge } from '@octobrief/application/testing'
import { type FactId, newId, type ProjectId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { setup } from './support.ts'

describe('knowledge API', () => {
  it('returns the facts of a project with their sources and the reading progress', async () => {
    const { deps, signIn, send } = setup()
    const paola = await signIn()
    const created = await send('/api/projects', 'POST', paola, { name: 'Aurora' })
    const project = (await created.json()) as { id: string }
    ;(deps.facts as InMemoryKnowledge).stored.push({
      id: newId<FactId>(),
      projectId: project.id as ProjectId,
      kind: 'risk',
      key: 'risk:fornitore',
      statement: 'Il fornitore è in ritardo.',
      value: null,
      sources: [],
      origin: 'compile',
      state: 'contested',
      lockedByPm: false,
      pmAsserted: false,
      createdAt: new Date('2026-11-12T09:00:00Z'),
    })

    const response = await send('/api/projects/aurora/knowledge', 'GET', paola)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      facts: [
        {
          kind: 'risk',
          key: 'risk:fornitore',
          statement: 'Il fornitore è in ritardo.',
          value: null,
          state: 'contested',
          createdAt: '2026-11-12T09:00:00.000Z',
          sources: [],
        },
      ],
      progress: { reading: 0, failed: 0, compiled: 0 },
    })
  })

  it('hides the knowledge of a project from who is not a member', async () => {
    const { api, signIn, send } = setup()
    const paola = await signIn()
    await send('/api/projects', 'POST', paola, { name: 'Aurora' })
    const marco = await signIn('marco@example.test', 'Marco Membro')
    expect((await send('/api/projects/aurora/knowledge', 'GET', marco)).status).toBe(404)
    expect((await api.request('/api/projects/aurora/knowledge')).status).toBe(401)
  })
})
