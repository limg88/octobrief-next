import type { InMemoryDocuments, InMemorySources } from '@octobrief/application/testing'
import { describe, expect, it } from 'vitest'
import { PUBLIC_URL, setup } from './support.ts'

async function project() {
  const context = setup()
  const paola = await context.signIn()
  await context.send('/api/projects', 'POST', paola, { name: 'Borea' })
  const ingest = (sourceId: string, token: string | null, body: unknown) =>
    context.api.request(`/api/ingest/${sourceId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  return { ...context, paola, ingest }
}

type Created = { source: { id: string; kind: string; name: string }; ingestToken: string | null }

describe('sources API', () => {
  it('connects a pushing source, lists it, rotates its token and disconnects it', async () => {
    const { paola, send } = await project()
    const response = await send('/api/projects/borea/sources', 'POST', paola, {
      kind: 'files',
      name: 'Cartella di progetto',
    })
    expect(response.status).toBe(201)
    const created = (await response.json()) as Created
    expect(created.source).toMatchObject({ kind: 'files', name: 'Cartella di progetto' })
    expect(created.ingestToken).toMatch(/^obf_/)

    const list = await send('/api/projects/borea/sources', 'GET', paola)
    expect(await list.json()).toMatchObject({
      sources: [{ id: created.source.id, documentCount: 0, lastSyncAt: null, lastError: null }],
    })
    const base = `/api/projects/borea/sources/${created.source.id}`
    const rotated = (await (await send(`${base}/token`, 'POST', paola)).json()) as {
      ingestToken: string
    }
    expect(rotated.ingestToken).not.toBe(created.ingestToken)
    expect((await send(`${base}/sync`, 'POST', paola)).status).toBe(409)
    expect((await send(base, 'DELETE', paola)).status).toBe(204)
    expect((await send(base, 'DELETE', paola)).status).toBe(404)
  })

  it('connects a pulling source after checking its credential, and reads it on request', async () => {
    const { paola, send } = await project()
    const body = { kind: 'jira', name: 'Jira', config: { site: 'contoso' }, scope: ['BOR'] }
    const refused = await send('/api/projects/borea/sources', 'POST', paola, {
      ...body,
      secret: 'wrong',
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'invalid', reason: 'source_auth_failed' })
    const missing = await send('/api/projects/borea/sources', 'POST', paola, body)
    expect(await missing.json()).toEqual({ error: 'invalid', reason: 'secret_required' })

    const created = await send('/api/projects/borea/sources', 'POST', paola, {
      ...body,
      secret: 'token-ok',
    })
    const { source, ingestToken } = (await created.json()) as Created
    expect(ingestToken).toBeNull()
    expect(JSON.stringify(source)).not.toContain('token-ok')
    const base = `/api/projects/borea/sources/${source.id}`
    expect((await send(`${base}/sync`, 'POST', paola)).status).toBe(202)
    expect((await send(`${base}/token`, 'POST', paola)).status).toBe(409)
  })

  it('lets only owners and admins manage sources', async () => {
    const { paola, send, signIn } = await project()
    const marco = await signIn('marco@example.test', 'Marco Membro')
    await send('/api/projects/borea/members', 'POST', paola, { email: 'marco@example.test' })
    const attempt = await send('/api/projects/borea/sources', 'POST', marco, {
      kind: 'files',
      name: 'x',
    })
    expect(attempt.status).toBe(403)
    expect((await send('/api/projects/borea/sources', 'GET', marco)).status).toBe(200)
  })
})

describe('ingest API', () => {
  async function fed() {
    const context = await project()
    const response = await context.send('/api/projects/borea/sources', 'POST', context.paola, {
      kind: 'm365',
      name: 'Posta',
    })
    const { source, ingestToken } = (await response.json()) as Created
    return { ...context, sourceId: source.id, token: ingestToken as string }
  }

  const delivery = {
    dataAsOf: '2026-11-12T08:00:00Z',
    documents: [
      {
        externalId: 'm-1',
        version: 'v1',
        title: 'RE: Budget',
        mediaType: 'text/markdown',
        text: 'Da: Carla\nBudget: 100 euro',
        originAt: '2026-11-10T08:00:00+01:00',
        people: [{ displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true }],
      },
      {
        externalId: 'f-1',
        version: 'v1',
        title: 'piano.pdf',
        mediaType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4').toString('base64'),
        kind: 'contract',
      },
    ],
    records: [{ externalId: 'BOR-1', version: '1', title: 'Storia', record: { status: 'Done' } }],
    rows: [
      {
        view: 'economics',
        perimeter: 'prj:PRJ000001',
        rows: [{ key: 'r1', values: { amount: 10 } }],
        extractedAt: '2026-11-12T08:00:00Z',
      },
    ],
    removed: ['BOR-9'],
  }

  it('stores a delivery with the token of the source, without a session', async () => {
    const { deps, ingest, sourceId, token, paola, send } = await fed()
    const response = await ingest(sourceId, token, delivery)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      duplicates: 0,
      records: 1,
      rows: 1,
      removed: 1,
    })
    const documents = [...(deps.documents as InMemoryDocuments).rows.values()]
    expect(documents.map((row) => [row.summary.fileName, row.systemKind])).toEqual([
      ['RE Budget.md', null],
      ['piano.pdf', 'contract'],
    ])
    expect((deps.sources as InMemorySources).people).toHaveLength(1)
    const list = await send('/api/projects/borea/documents', 'GET', paola)
    const listed = (await list.json()) as { documents: Array<Record<string, unknown>> }
    expect(listed.documents[0]).toMatchObject({
      sourceName: 'Posta',
      originAt: '2026-11-10T07:00:00.000Z',
    })
    expect(await (await ingest(sourceId, token, delivery)).json()).toMatchObject({
      created: 0,
      unchanged: 2,
    })
  })

  it('refuses a missing or wrong token, a malformed delivery and one that is too large', async () => {
    const { api, ingest, sourceId, token } = await fed()
    expect((await ingest(sourceId, null, delivery)).status).toBe(401)
    expect((await ingest(sourceId, 'obf_wrong', delivery)).status).toBe(401)
    const both = { documents: [{ ...delivery.documents[0], contentBase64: 'AAAA' }] }
    expect((await ingest(sourceId, token, both)).status).toBe(400)
    expect((await ingest(sourceId, token, { documents: [{ externalId: 'x' }] })).status).toBe(400)
    const huge = await api.request(`/api/ingest/${sourceId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'content-length': String(64 * 1024 * 1024),
        origin: PUBLIC_URL,
      },
      body: '{}',
    })
    expect(huge.status).toBe(413)
  })
})
