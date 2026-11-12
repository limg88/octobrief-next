import type { Extraction, User } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { ApplicationError } from '../src/errors.ts'
import {
  createProcessDocumentHandler,
  createPurgeDocumentsHandler,
  deleteDocument,
  getDocumentText,
  listDocuments,
  reclassifyDocument,
  uploadDocument,
} from '../src/use-cases/documents.ts'
import { addMember, createProject } from '../src/use-cases/projects.ts'
import {
  FakeExtractor,
  InMemoryBlobs,
  InMemoryDocuments,
  InMemoryJobQueue,
  InMemoryProjects,
  InMemoryUsers,
  RecordingLogger,
} from './fakes.ts'

function person(id: string, role: User['role'] = 'pm'): User {
  return { id, displayName: id, email: `${id}@example.test`, role, locale: 'it' }
}

const text = (lines: string[]): Extraction => ({
  extractor: 'test/1',
  chunks: lines.map((line, i) => ({
    locator: { kind: 'line', from: i + 1, to: i + 1 },
    text: line,
  })),
  truncated: false,
  metadataDate: null,
  warnings: [],
})

const bytes = (content: string) => new TextEncoder().encode(content)

async function setup() {
  const users = new InMemoryUsers()
  const projects = new InMemoryProjects(users)
  const documents = new InMemoryDocuments(projects, users)
  const blobs = new InMemoryBlobs()
  const queue = new InMemoryJobQueue()
  const logger = new RecordingLogger()
  const deps = { users, projects, documents, blobs, queue }
  const paola = users.add(person('paola'))
  const marco = users.add(person('marco'))
  const giulia = users.add(person('giulia'))
  const alba = users.add(person('alba', 'admin'))
  const project = await createProject(deps, paola, { name: 'Aurora' })
  await addMember(deps, paola, project.slug, 'marco@example.test')
  const extractor = new FakeExtractor((fileName) =>
    fileName.endsWith('.bin')
      ? { ...text([]), warnings: ['unsupported_format'] }
      : text(['Stato avanzamento lavori', 'Avanzamento: 60%']),
  )
  const process = createProcessDocumentHandler({
    store: documents,
    blobs,
    extractor,
    jobs: queue,
    logger,
  })
  const upload = (viewer: User, fileName: string, content = fileName) =>
    uploadDocument(deps, viewer, project.slug, {
      fileName,
      mediaType: 'text/plain',
      bytes: bytes(content),
    })
  return {
    deps,
    documents,
    blobs,
    queue,
    logger,
    process,
    upload,
    project,
    paola,
    marco,
    giulia,
    alba,
  }
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApplicationError) return error.code
    throw error
  }
  return undefined
}

describe('documents', () => {
  it('stores an upload, queues its processing and refuses the same content twice', async () => {
    const { upload, queue, blobs, paola, marco } = await setup()
    const document = await upload(paola, 'C:\\tmp\\SAL ottobre.md', 'stessi byte')
    expect(document).toMatchObject({ fileName: 'SAL ottobre.md', status: 'pending' })
    expect([...queue.jobs.values()]).toEqual([
      { name: 'document.process', data: { documentId: document.id }, status: 'queued' },
    ])
    expect(blobs.blobs.size).toBe(1)
    expect(await code(upload(marco, 'copia.md', 'stessi byte'))).toBe('conflict')
  })

  it('hides documents from people outside the project', async () => {
    const { deps, upload, project, paola, giulia, alba } = await setup()
    await upload(paola, 'nota.txt')
    expect(await code(listDocuments(deps, giulia, project.slug))).toBe('not_found')
    expect(await code(upload(giulia, 'x.txt'))).toBe('not_found')
    expect(await listDocuments(deps, alba, project.slug)).toHaveLength(1)
  })

  it('extracts and classifies a document in the worker, once', async () => {
    const { deps, upload, process, logger, project, paola } = await setup()
    const document = await upload(paola, 'SAL-Aurora-2026-11-04.md')
    await process({ documentId: document.id })
    await process({ documentId: document.id })
    const { document: ready, chunks } = await getDocumentText(
      deps,
      paola,
      project.slug,
      document.id,
    )
    expect(ready).toMatchObject({ status: 'ready', kind: 'status_report', chunkCount: 2 })
    expect(chunks.map((c) => c.text)).toEqual(['Stato avanzamento lavori', 'Avanzamento: 60%'])
    expect(logger.entries.filter((e) => e.message === 'document processed')).toHaveLength(1)
  })

  it('marks an unreadable file as failed', async () => {
    const { deps, upload, process, project, paola } = await setup()
    const document = await upload(paola, 'archivio.bin')
    await process({ documentId: document.id })
    const { document: failed } = await getDocumentText(deps, paola, project.slug, document.id)
    expect(failed).toMatchObject({ status: 'failed', warnings: ['unsupported_format'] })
  })

  it('ignores a job for a document that is gone', async () => {
    const { process, logger } = await setup()
    await process({ documentId: '00000000-0000-4000-8000-000000000000' })
    expect(logger.entries).toEqual([])
  })

  it('records the PM classification, only once the document is classified', async () => {
    const { deps, upload, process, project, paola } = await setup()
    const document = await upload(paola, 'nota.txt')
    expect(
      await code(reclassifyDocument(deps, paola, project.slug, document.id, { kind: 'contract' })),
    ).toBe('conflict')
    await process({ documentId: document.id })
    const updated = await reclassifyDocument(deps, paola, project.slug, document.id, {
      audience: 'client',
    })
    expect(updated).toMatchObject({ audience: 'client', audienceSource: 'pm' })
    expect(updated.uncertain).not.toContain('audience')
  })

  it('lets the uploader, the owner and an admin delete, not other members', async () => {
    const { deps, upload, blobs, project, paola, marco, alba } = await setup()
    const byPaola = await upload(paola, 'a.txt')
    const byMarco = await upload(marco, 'b.txt')
    const another = await upload(marco, 'c.txt')
    expect(await code(deleteDocument(deps, marco, project.slug, byPaola.id))).toBe('forbidden')
    await deleteDocument(deps, marco, project.slug, byMarco.id)
    await deleteDocument(deps, paola, project.slug, another.id)
    await deleteDocument(deps, alba, project.slug, byPaola.id)
    expect(await listDocuments(deps, paola, project.slug)).toEqual([])
    expect(blobs.blobs.size).toBe(0)
    expect(await code(deleteDocument(deps, paola, project.slug, byPaola.id))).toBe('not_found')
  })

  it('purges documents past their retention, bytes included', async () => {
    const { upload, documents, blobs, logger, paola } = await setup()
    await upload(paola, 'vecchio.txt')
    const purge = (now: string) =>
      createPurgeDocumentsHandler({
        store: documents,
        blobs,
        logger,
        now: () => new Date(now),
        retentionCutoff: (at) => new Date(at.getTime() - 24 * 60 * 60 * 1000),
      })()
    await purge('2026-11-11T12:00:00Z')
    expect(documents.rows.size).toBe(1)
    await purge('2026-11-13T00:00:00Z')
    expect(documents.rows.size).toBe(0)
    expect(blobs.blobs.size).toBe(0)
    expect(logger.entries.at(-1)).toMatchObject({ message: 'expired documents removed' })
  })
})
