import { createProcessDocumentHandler } from '@octobrief/application'
import { FakeExtractor, type InMemoryDocuments } from '@octobrief/application/testing'
import { MAX_DOCUMENT_BYTES } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { PUBLIC_URL, setup } from './support.ts'

type Auth = { cookie: string; csrfToken: string }

async function project() {
  const context = setup()
  const paola = await context.signIn()
  await context.send('/api/projects', 'POST', paola, { name: 'Aurora' })
  const upload = (
    auth: Auth,
    name: string,
    content: string | Uint8Array<ArrayBuffer> = name,
    csrf = auth.csrfToken,
  ) => {
    const form = new FormData()
    form.append('file', new File([content], name, { type: 'text/markdown' }))
    return context.api.request('/api/projects/aurora/documents', {
      method: 'POST',
      headers: { cookie: auth.cookie, 'x-csrf-token': csrf, origin: PUBLIC_URL },
      body: form,
    })
  }
  return { ...context, paola, upload }
}

describe('documents API', () => {
  it('uploads, lists, processes, shows text and reclassifies', async () => {
    const { deps, paola, send, upload } = await project()
    const created = await upload(paola, 'SAL-Aurora-2026-11-04.md', 'Stato avanzamento lavori')
    expect(created.status).toBe(201)
    const document = (await created.json()) as { id: string; status: string; fileName: string }
    expect(document).toMatchObject({ status: 'pending', fileName: 'SAL-Aurora-2026-11-04.md' })

    const list = await send('/api/projects/aurora/documents', 'GET', paola)
    expect(((await list.json()) as { documents: unknown[] }).documents).toHaveLength(1)

    await createProcessDocumentHandler({
      store: deps.documents as InMemoryDocuments,
      blobs: deps.blobs,
      jobs: deps.queue,
      extractor: new FakeExtractor(() => ({
        extractor: 'test/1',
        chunks: [{ locator: { kind: 'line', from: 1, to: 1 }, text: 'Stato avanzamento lavori' }],
        truncated: false,
        metadataDate: null,
        warnings: [],
      })),
      logger: deps.logger,
    })({ documentId: document.id })

    const text = await send(`/api/projects/aurora/documents/${document.id}`, 'GET', paola)
    expect(await text.json()).toMatchObject({
      document: { status: 'ready', kind: 'status_report', chunkCount: 1 },
      chunks: [{ locator: { kind: 'line', from: 1, to: 1 }, text: 'Stato avanzamento lavori' }],
    })

    const patched = await send(`/api/projects/aurora/documents/${document.id}`, 'PATCH', paola, {
      audience: 'client',
    })
    expect(await patched.json()).toMatchObject({ audience: 'client', audienceSource: 'pm' })

    const removed = await send(`/api/projects/aurora/documents/${document.id}`, 'DELETE', paola)
    expect(removed.status).toBe(204)
  })

  it('refuses duplicates, empty files and missing CSRF tokens', async () => {
    const { paola, upload } = await project()
    expect((await upload(paola, 'a.md', 'x')).status).toBe(201)
    expect((await upload(paola, 'b.md', 'x')).status).toBe(409)
    const empty = await upload(paola, 'c.md', '')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: 'invalid', reason: 'empty' })
    expect((await upload(paola, 'd.md', 'y', 'wrong')).status).toBe(403)
  })

  it('refuses a file over the size limit before reading it', async () => {
    const { paola, upload } = await project()
    const res = await upload(paola, 'big.bin', new Uint8Array(MAX_DOCUMENT_BYTES + 128 * 1024))
    expect(res.status).toBe(413)
  })

  it('hides documents from outsiders', async () => {
    const { signIn, send, paola, upload } = await project()
    await upload(paola, 'a.md')
    const marco = await signIn('marco.esempio@example.test', 'Marco Esempio')
    expect((await send('/api/projects/aurora/documents', 'GET', marco)).status).toBe(404)
    expect((await upload(marco, 'b.md')).status).toBe(404)
  })
})
