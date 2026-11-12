import type {
  Audience,
  DateSource,
  DocumentKind,
  DocumentStatus,
  FactKind,
  FactState,
  Locale,
  Locator,
  MemberRole,
  QuestionPhase,
  SourceKind,
  Uncertain,
  UserRole,
  VerifiedAnswer,
} from '@octobrief/domain'

// Shapes of the JSON responses, as documented in /api/openapi.json.

export interface SessionUser {
  id: string
  displayName: string
  email: string | null
  role: UserRole
  locale: Locale
}

export interface ProjectDto {
  id: string
  slug: string
  name: string
  client: string | null
  createdAt: string
  memberRole: MemberRole | null
}

export interface MemberDto {
  userId: string
  displayName: string
  email: string | null
  role: MemberRole
}

export interface DocumentDto {
  id: string
  fileName: string
  mediaType: string
  sizeBytes: number
  status: DocumentStatus
  kind: DocumentKind | null
  audience: Audience | null
  audienceSource: 'pm' | 'rule' | 'default' | null
  documentDate: string | null
  dateSource: DateSource | null
  uncertain: Uncertain[]
  warnings: string[]
  chunkCount: number
  uploadedBy: string
  uploaderName: string
  uploadedAt: string
  sourceName: string | null
  originAt: string | null
}

/** A value as JSON carries it: dates become ISO strings. */
type Jsonify<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? Jsonify<U>[]
      : { [K in keyof T]: Jsonify<T[K]> }

export type AnswerDto = Jsonify<VerifiedAnswer>
export type AnswerSegmentDto = AnswerDto['segments'][number]
export type AnswerSourceDto = AnswerSegmentDto['sources'][number]

export interface QuestionSummaryDto {
  id: string
  text: string
  phase: QuestionPhase
  error: string | null
  askedAt: string
  answeredAt: string | null
}

export interface QuestionDto extends QuestionSummaryDto {
  answer: AnswerDto | null
}

export interface SourceDto {
  id: string
  kind: SourceKind
  name: string
  perimeter: string[]
  lastSyncAt: string | null
  dataAsOf: string | null
  lastError: string | null
  documentCount: number
  createdAt: string
}

export interface FactDto {
  id: string
  kind: FactKind
  key: string
  statement: string
  value: string | null
  state: FactState
  createdAt: string
  sources: { documentId: string; fileName: string; locator: Locator; excerpt: string }[]
}

export interface KnowledgeDto {
  facts: FactDto[]
  progress: { reading: number; failed: number; compiled: number }
}

export interface DocumentTextDto {
  document: DocumentDto
  chunks: { locator: Locator; text: string }[]
}
