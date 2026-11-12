import type {
  Classification,
  ClassificationState,
  DocumentKind,
  DocumentSummary,
  Extraction,
  TextChunk,
} from '@octobrief/domain'

export interface NewDocument {
  readonly projectId: string
  readonly fileName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly blobKey: string
  readonly uploadedBy: string
}

/**
 * Documents as a signed-in person sees them. Every call runs as `viewerId`, so the database
 * shows only documents of projects that person may see.
 */
export interface DocumentRepository {
  /** Null when the project already holds a file with the same content. */
  create(viewerId: string, document: NewDocument): Promise<DocumentSummary | null>
  list(viewerId: string, projectId: string): Promise<DocumentSummary[]>
  find(viewerId: string, projectId: string, documentId: string): Promise<DocumentSummary | null>
  /** The first `limit` chunks of extracted text, in document order. */
  chunks(viewerId: string, documentId: string, limit: number): Promise<TextChunk[]>
  saveClassification(
    viewerId: string,
    documentId: string,
    state: ClassificationState,
  ): Promise<DocumentSummary>
  /** Removes the document and its text; returns the key of its bytes. */
  remove(viewerId: string, documentId: string): Promise<string | null>
}

export interface DocumentToProcess {
  readonly id: string
  readonly fileName: string
  readonly mediaType: string
  readonly blobKey: string
  readonly uploadedAt: Date
  /** When the source system says the item was made or changed, for a document of a source. */
  readonly originAt?: Date | null
  /** When the file was last changed where a feeder read it. */
  readonly fileModifiedAt?: Date | null
  /** The kind its source declares for it. */
  readonly systemKind?: DocumentKind | null
}

/** The worker's view of documents: no viewer, every project. */
export interface DocumentProcessingStore {
  /** A pending document, or null when it is gone or already processed. */
  pending(documentId: string): Promise<DocumentToProcess | null>
  markReady(
    documentId: string,
    extraction: Extraction,
    classification: Classification,
  ): Promise<void>
  markFailed(documentId: string, extraction: Extraction): Promise<void>
  /**
   * Remembers people a document names (speakers, participants) with its project, so that no
   * model reads their names. Names chosen outside the organization: hidden in full only.
   */
  rememberPeople(documentId: string, names: readonly string[]): Promise<void>
  /** Up to `limit` documents uploaded before `cutoff`. */
  expired(cutoff: Date, limit: number): Promise<Array<{ id: string; blobKey: string }>>
  removeExpired(documentId: string): Promise<void>
}
