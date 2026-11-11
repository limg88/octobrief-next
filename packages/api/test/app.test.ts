import type { HealthProbe, JobQueue } from '@octobrief/application'
import type { JobStatus } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { createApi } from '../src/app.ts'

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
    const api = createApi({ probes: [up], queue: fakeQueue() })
    const res = await api.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'up',
      components: [{ name: 'database', status: 'up' }],
    })
  })

  it('answers 503 when a component is down', async () => {
    const api = createApi({ probes: [up, down], queue: fakeQueue() })
    const res = await api.request('/api/health')
    expect(res.status).toBe(503)
  })
})

describe('ping routes', () => {
  it('queues a ping and returns its job id', async () => {
    const api = createApi({ probes: [], queue: fakeQueue() })
    const res = await api.request('/api/system/pings', { method: 'POST' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ jobId: JOB_ID })
  })

  it('returns the status of a known ping', async () => {
    const api = createApi({ probes: [], queue: fakeQueue({ [JOB_ID]: 'completed' }) })
    const res = await api.request(`/api/system/pings/${JOB_ID}`)
    expect(await res.json()).toEqual({ jobId: JOB_ID, status: 'completed' })
  })

  it('answers 404 for an unknown ping', async () => {
    const api = createApi({ probes: [], queue: fakeQueue() })
    const res = await api.request(`/api/system/pings/${JOB_ID}`)
    expect(res.status).toBe(404)
  })

  it('rejects a malformed job id', async () => {
    const api = createApi({ probes: [], queue: fakeQueue() })
    const res = await api.request('/api/system/pings/not-a-uuid')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/openapi.json', () => {
  it('documents every route', async () => {
    const api = createApi({ probes: [], queue: fakeQueue() })
    const doc = (await (await api.request('/api/openapi.json')).json()) as {
      paths: Record<string, unknown>
    }
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/health',
      '/api/system/pings',
      '/api/system/pings/{jobId}',
    ])
  })
})
