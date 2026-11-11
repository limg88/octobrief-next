import type { HealthProbe, JobQueue } from '@octobrief/application'
import type { JobStatus } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { setup } from './support.ts'

const JOB_ID = '7b0f3f8e-2a52-4a39-9a5e-3c1f1f0d9a10'

function fakeQueue(statuses: Record<string, JobStatus> = {}): JobQueue {
  return {
    enqueue: async () => JOB_ID,
    status: async (_name, id) => statuses[id] ?? null,
  }
}

const up: HealthProbe = { name: 'database', check: async () => true }
const down: HealthProbe = { name: 'queue', check: async () => false }

describe('GET /api/health', () => {
  it('answers 200 when every component is up', async () => {
    const { api } = setup({ probes: [up] })
    const res = await api.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'up',
      components: [{ name: 'database', status: 'up' }],
    })
  })

  it('answers 503 when a component is down', async () => {
    const { api } = setup({ probes: [up, down] })
    expect((await api.request('/api/health')).status).toBe(503)
  })
})

describe('ping routes (admins only)', () => {
  it('refuses anonymous callers and plain PMs', async () => {
    const { api, signIn, send } = setup({ queue: fakeQueue() })
    expect((await api.request('/api/system/pings', { method: 'POST' })).status).toBe(401)
    const pm = await signIn()
    expect((await send('/api/system/pings', 'POST', pm)).status).toBe(403)
  })

  it('queues a ping and reports its status for an admin', async () => {
    const { signIn, send } = setup({ queue: fakeQueue({ [JOB_ID]: 'completed' }) })
    const admin = await signIn('alba@example.test', 'Alba')
    const queued = await send('/api/system/pings', 'POST', admin)
    expect(queued.status).toBe(202)
    expect(await queued.json()).toEqual({ jobId: JOB_ID })
    const status = await send(`/api/system/pings/${JOB_ID}`, 'GET', admin)
    expect(await status.json()).toEqual({ jobId: JOB_ID, status: 'completed' })
  })

  it('answers 404 for an unknown ping and 400 for a malformed id', async () => {
    const { signIn, send } = setup({ queue: fakeQueue() })
    const admin = await signIn('alba@example.test', 'Alba')
    expect((await send(`/api/system/pings/${JOB_ID}`, 'GET', admin)).status).toBe(404)
    expect((await send('/api/system/pings/not-a-uuid', 'GET', admin)).status).toBe(400)
  })
})

describe('errors', () => {
  it('hides unexpected failures behind a 500 and logs them', async () => {
    const { api, deps, logger, signIn } = setup()
    deps.projects.listVisible = async () => {
      throw new Error('boom')
    }
    const { cookie } = await signIn()
    const res = await api.request('/api/projects', { headers: { cookie } })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
    expect(logger.entries.at(-1)).toMatchObject({ message: 'request failed', level: 'error' })
  })
})

describe('GET /api/openapi.json', () => {
  it('documents the JSON routes', async () => {
    const { api } = setup()
    const doc = (await (await api.request('/api/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/health',
      '/api/me',
      '/api/projects',
      '/api/projects/{slug}',
      '/api/projects/{slug}/members',
      '/api/system/pings',
      '/api/system/pings/{jobId}',
    ])
  })
})
