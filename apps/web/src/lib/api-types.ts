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

export interface RecipeParameterDto {
  id: string
  type: string
  label: string
  help?: string
  required: boolean
  maxLength?: number
  multiple?: boolean
  documentKinds?: string[]
  options?: { value: string; label: string }[]
  columns?: { id: string; label: string; kind: string }[]
}

export interface RecipeDto {
  slug: string
  version: string
  title: string
  purpose: string
  audience: string
  formats: string[]
  parameters: RecipeParameterDto[]
}

export interface RunDto {
  id: string
  recipeSlug: string
  recipeTitle: string
  status: 'queued' | 'running' | 'ready' | 'failed' | 'discarded'
  phase: 'gathering' | 'writing' | 'checking' | 'revising' | null
  errorCode: string | null
  revisionError: string | null
  approval: 'approving' | 'approved' | 'render_failed' | null
  approvalError: string | null
  requestedBy: string
  createdAt: string
  approvedAt: string | null
}

export interface FindingDto {
  code: string
  class: 'data' | 'form' | 'structure'
  kind: 'anomaly' | 'warning'
  refKey: string
  slot: string | null
  status: 'open' | 'accepted' | 'decided' | null
  acceptable: boolean
  text: string
  place: { section?: string; block?: string }
  excerpt: string | null
}

interface CellDto {
  text: string | null
  sources?: number[]
}

export type DeliverableBlockDto =
  | { id: string; kind: 'static'; text: string }
  | { id: string; kind: 'value'; label: string; cell: CellDto }
  | {
      id: string
      kind: 'text'
      title?: string
      segments: { text: string; sources?: number[] }[]
    }
  | {
      id: string
      kind: 'table'
      title?: string
      columns: { id: string; title: string }[]
      rows: { key: string; cells: CellDto[] }[]
    }
  | {
      id: string
      kind: 'list'
      title?: string
      columns: { id: string; title: string }[]
      items: { key: string; cells: CellDto[] }[]
    }

export interface DeliverableDocumentDto {
  title: string
  sections: { id: string; title: string; blocks: DeliverableBlockDto[] }[]
  sourceNotes: { n: number; label: string }[]
}

export interface RunViewDto {
  run: RunDto
  document: DeliverableDocumentDto | null
  revision: number
  findings: FindingDto[]
  summary: { checks: number; open: number; accepted: number; warnings: number } | null
  files: {
    id: string
    audience: 'internal' | 'client'
    format: string
    fileName: string
    sizeBytes: number
  }[]
  approvable: boolean
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
