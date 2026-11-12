import {
  type Audience,
  canDeleteDocument,
  classify,
  correctClassification,
  type DocumentKind,
  type DocumentSummary,
  type Extraction,
  type ExtractionWarning,
  isAdmin,
  type TextChunk,
  type User,
  validateUpload,
} from '@octobrief/domain'
import { ApplicationError } from '../errors.ts'
import type { BlobStore } from '../ports/blob-store.ts'
import type { DocumentProcessingStore, DocumentRepository } from '../ports/document-repository.ts'
import type { JobQueue } from '../ports/job-queue.ts'
import type { Logger } from '../ports/logger.ts'
import type { TextExtractor } from '../ports/text-extractor.ts'
import { getProject, type ProjectDependencies } from './projects.ts'

/** Chunks shown in the text preview of a document. */
export const PREVIEW_CHUNKS = 50
/** Expired documents removed per purge run; the next run takes the rest. */
export const PURGE_BATCH = 200
/** Characters of the text the classifier reads. */
const CLASSIFY_WINDOW = 2_000
/** Media type stored when the browser gives none. */
const UNKNOWN_MEDIA_TYPE = 'application/octet-stream'
/** An extraction with these warnings and no text means the file could not be read. */
const FATAL_WARNINGS: ReadonlySet<ExtractionWarning> = new Set([
  'encrypted',
  'unsupported_format',
  'timeout',
  'extraction_failed',
])

export interface DocumentDependencies extends ProjectDependencies {
  readonly documents: DocumentRepository
  readonly blobs: BlobStore
  readonly queue: JobQueue
}

export interface Upload {
  readonly fileName: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

/** Stores the file and queues its extraction; the same content twice is a conflict. */
export async function uploadDocument(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
  upload: Upload,
): Promise<DocumentSummary> {
  const project = await getProject(deps, viewer, slug)
  const { fileName } = validateUpload({ fileName: upload.fileName, sizeBytes: upload.bytes.length })
  const { key, sha256 } = await deps.blobs.put(project.id, upload.bytes)
  const document = await deps.documents.create(viewer.id, {
    projectId: project.id,
    fileName,
    mediaType: upload.mediaType.trim() || UNKNOWN_MEDIA_TYPE,
    sizeBytes: upload.bytes.length,
    sha256,
    blobKey: key,
    uploadedBy: viewer.id,
  })
  if (!document) throw new ApplicationError('conflict', 'the project already holds this file')
  await deps.queue.enqueue('document.process', { documentId: document.id })
  return document
}

export async function listDocuments(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
): Promise<DocumentSummary[]> {
  const project = await getProject(deps, viewer, slug)
  return deps.documents.list(viewer.id, project.id)
}

async function findDocument(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
  documentId: string,
) {
  const project = await getProject(deps, viewer, slug)
  const document = await deps.documents.find(viewer.id, project.id, documentId)
  if (!document) throw new ApplicationError('not_found', 'document not found')
  return { project, document }
}

/** The document with the start of its extracted text. */
export async function getDocumentText(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
  documentId: string,
): Promise<{ document: DocumentSummary; chunks: TextChunk[] }> {
  const { document } = await findDocument(deps, viewer, slug, documentId)
  const chunks = await deps.documents.chunks(viewer.id, document.id, PREVIEW_CHUNKS)
  return { document, chunks }
}

/** Records the PM's choice of kind and audience on a classified document. */
export async function reclassifyDocument(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
  documentId: string,
  change: { kind?: DocumentKind | undefined; audience?: Audience | undefined },
): Promise<DocumentSummary> {
  const { document } = await findDocument(deps, viewer, slug, documentId)
  if (!document.kind || !document.audience || !document.audienceSource) {
    throw new ApplicationError('conflict', 'the document is not classified yet')
  }
  const state = correctClassification(
    {
      kind: document.kind,
      audience: document.audience,
      audienceSource: document.audienceSource,
      uncertain: document.uncertain,
    },
    change,
  )
  return deps.documents.saveClassification(viewer.id, document.id, state)
}

export async function deleteDocument(
  deps: DocumentDependencies,
  viewer: User,
  slug: string,
  documentId: string,
): Promise<void> {
  const { project, document } = await findDocument(deps, viewer, slug, documentId)
  const allowed = canDeleteDocument({
    viewerId: viewer.id,
    uploaderId: document.uploadedBy,
    memberRole: project.memberRole,
    admin: isAdmin(viewer),
  })
  if (!allowed) throw new ApplicationError('forbidden', 'only the uploader, owners and admins')
  const key = await deps.documents.remove(viewer.id, document.id)
  if (key) await deps.blobs.delete(key)
}

export interface ProcessingDependencies {
  readonly store: DocumentProcessingStore
  readonly blobs: BlobStore
  readonly extractor: TextExtractor
  /** Where the reading of a classified document is queued. */
  readonly jobs: Pick<JobQueue, 'enqueue'>
  readonly logger: Logger
}

function unreadable(extraction: Extraction): boolean {
  return (
    extraction.chunks.length === 0 &&
    extraction.warnings.some((warning) => FATAL_WARNINGS.has(warning))
  )
}

function leadingText(chunks: readonly TextChunk[]): string {
  let text = ''
  for (const chunk of chunks) {
    if (text.length >= CLASSIFY_WINDOW) break
    text += `${chunk.text}\n`
  }
  return text
}

/** Worker job: extracts the text of an uploaded file, classifies it by rules, queues its reading. */
export function createProcessDocumentHandler(deps: ProcessingDependencies) {
  return async ({ documentId }: { documentId: string }): Promise<void> => {
    const document = await deps.store.pending(documentId)
    if (!document) return
    const bytes = await deps.blobs.get(document.blobKey)
    const extraction = await deps.extractor.extract(bytes, document.mediaType, document.fileName)
    if (unreadable(extraction)) {
      await deps.store.markFailed(document.id, extraction)
      deps.logger.error('document unreadable', { documentId, warnings: extraction.warnings })
      return
    }
    const classification = classify({
      fileName: document.fileName,
      mediaType: document.mediaType,
      text: leadingText(extraction.chunks),
      lang: 'it',
      metadataDate: extraction.metadataDate,
      acquiredAt: document.uploadedAt,
    })
    await deps.store.markReady(document.id, extraction, classification)
    await deps.jobs.enqueue('document.compile', { documentId: document.id })
    deps.logger.info('document processed', {
      documentId,
      chunks: extraction.chunks.length,
      kind: classification.kind,
    })
  }
}

export interface PurgeDependencies {
  readonly store: DocumentProcessingStore
  readonly blobs: BlobStore
  readonly logger: Logger
  readonly now: () => Date
  readonly retentionCutoff: (now: Date) => Date
}

/** Worker job: removes documents past their retention, bytes first so nothing is orphaned. */
export function createPurgeDocumentsHandler(deps: PurgeDependencies) {
  return async (): Promise<void> => {
    const expired = await deps.store.expired(deps.retentionCutoff(deps.now()), PURGE_BATCH)
    for (const document of expired) {
      await deps.blobs.delete(document.blobKey)
      await deps.store.removeExpired(document.id)
    }
    if (expired.length > 0) deps.logger.info('expired documents removed', { count: expired.length })
  }
}
