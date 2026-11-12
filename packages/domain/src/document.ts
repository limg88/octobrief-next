import {
  type Audience,
  type Classification,
  type DocumentKind,
  isInternalOnly,
  type Uncertain,
} from './classification.ts'
import type { DateSource } from './document-date.ts'
import type { ExtractionWarning } from './extraction.ts'
import type { MemberRole } from './project.ts'

/** Upload size limit: 50 MiB. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
export const FILE_NAME_MAX_LENGTH = 255
/** Default retention of uploaded documents, in days. */
export const DEFAULT_RETENTION_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/** `pending` until the worker has extracted and classified it, then `ready` or `failed`. */
export const DOCUMENT_STATUSES = ['pending', 'ready', 'failed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export interface DocumentSummary {
  readonly id: string
  readonly projectId: string
  readonly fileName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly status: DocumentStatus
  readonly kind: DocumentKind | null
  readonly audience: Audience | null
  readonly audienceSource: Classification['audienceSource'] | null
  readonly documentDate: Date | null
  readonly dateSource: DateSource | null
  readonly uncertain: readonly Uncertain[]
  readonly warnings: readonly ExtractionWarning[]
  readonly chunkCount: number
  readonly uploadedBy: string
  readonly uploaderName: string
  readonly uploadedAt: Date
  /** The source that brought the document; null for a manual upload. */
  readonly sourceName: string | null
  /** When the source system says the item was made or changed. */
  readonly originAt: Date | null
}

export type InvalidDocumentReason = 'empty' | 'too_large' | 'invalid_name'

export class InvalidDocumentError extends Error {
  readonly reason: InvalidDocumentReason
  constructor(reason: InvalidDocumentReason) {
    super(`invalid document: ${reason}`)
    this.name = 'InvalidDocumentError'
    this.reason = reason
  }
}

const FIRST_PRINTABLE = 0x20
const DELETE = 0x7f

/** Control characters never belong in a file name shown back to people. */
function withoutControlCharacters(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return code >= FIRST_PRINTABLE && code !== DELETE
    })
    .join('')
}

/** The last path segment, without control characters; throws when nothing usable is left. */
export function normalizeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const name = withoutControlCharacters(base).trim()
  if (name === '' || name === '.' || name === '..' || name.length > FILE_NAME_MAX_LENGTH) {
    throw new InvalidDocumentError('invalid_name')
  }
  return name
}

/** Checks an upload before anything is stored. */
export function validateUpload(input: { fileName: string; sizeBytes: number }): {
  fileName: string
} {
  if (input.sizeBytes === 0) throw new InvalidDocumentError('empty')
  if (input.sizeBytes > MAX_DOCUMENT_BYTES) throw new InvalidDocumentError('too_large')
  return { fileName: normalizeFileName(input.fileName) }
}

/** The uploader, the project owner and an admin may remove a document. */
export function canDeleteDocument(input: {
  viewerId: string
  uploaderId: string
  memberRole: MemberRole | null
  admin: boolean
}): boolean {
  return input.admin || input.memberRole === 'owner' || input.viewerId === input.uploaderId
}

/** Documents uploaded before this instant are past their retention. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

export interface ClassificationState {
  readonly kind: DocumentKind
  readonly audience: Audience
  readonly audienceSource: Classification['audienceSource']
  readonly uncertain: readonly Uncertain[]
}

/**
 * Applies what the PM decided. A field the PM set is no longer uncertain; a kind that is internal
 * by rule (economics) stays internal whatever audience the PM picks.
 */
export function correctClassification(
  current: ClassificationState,
  change: { kind?: DocumentKind | undefined; audience?: Audience | undefined },
): ClassificationState {
  const kind = change.kind ?? current.kind
  const settled = new Set<Uncertain>()
  if (change.kind) settled.add('kind')
  if (change.audience) settled.add('audience')
  if (isInternalOnly(kind)) {
    settled.add('audience')
    return {
      kind,
      audience: 'internal',
      audienceSource: 'rule',
      uncertain: current.uncertain.filter((field) => !settled.has(field)),
    }
  }
  const uncertain = current.uncertain.filter((field) => !settled.has(field))
  if (change.audience) return { kind, audience: change.audience, audienceSource: 'pm', uncertain }
  return { kind, audience: current.audience, audienceSource: current.audienceSource, uncertain }
}
