import type {
  Classification,
  Fact,
  FactKind,
  FactState,
  KnownPerson,
  Locator,
  ProposedFact,
  SourceRef,
  TextChunk,
} from '@octobrief/domain'
import type { EmbeddingModel } from './model-runner.ts'

/** A classified document whose knowledge is still to be compiled, with its whole text. */
export interface DocumentToCompile {
  readonly id: string
  readonly projectId: string
  readonly fileName: string
  readonly uploadedBy: string
  readonly classification: Classification
  /** Every chunk, in document order. */
  readonly chunks: readonly TextChunk[]
}

/** What compiling a document changes in the knowledge of its project. */
export type KnowledgeChange =
  | { readonly kind: 'insert'; readonly fact: Fact }
  | { readonly kind: 'add_sources'; readonly factId: string; readonly sources: SourceRef[] }
  /** A fact that held nothing any more takes the proposed content, active again. */
  | { readonly kind: 'replace'; readonly factId: string; readonly proposed: ProposedFact }
  /** `fact` says otherwise than `factId`: both are kept side by side, contested. */
  | { readonly kind: 'contest'; readonly factId: string; readonly fact: Fact }

export const KNOWLEDGE_STATUSES = ['pending', 'ready', 'failed'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/** The worker's view of the knowledge: no viewer, every project. */
export interface KnowledgeStore {
  /** Null when the document is gone, not classified yet or already compiled. */
  compilable(documentId: string): Promise<DocumentToCompile | null>
  /** Every fact of the project with its sources. */
  facts(projectId: string): Promise<Fact[]>
  /** People and organizations of the project whose names never reach a model. */
  people(projectId: string): Promise<KnownPerson[]>
  /** One vector per chunk, in document order, with the encoder that made them. */
  saveEmbeddings(documentId: string, encoder: EmbeddingModel, vectors: number[][]): Promise<void>
  /**
   * Applies the changes and marks the document compiled, all or nothing. `suspicious`: its text
   * holds sentences shaped like instructions (shown with a warning, never followed).
   */
  saveKnowledge(
    documentId: string,
    changes: readonly KnowledgeChange[],
    suspicious: boolean,
  ): Promise<void>
  /** `code` is a stable error code, never a message of the model. */
  markKnowledgeFailed(documentId: string, code: string): Promise<void>
}

export interface FactSourceView {
  readonly documentId: string
  readonly fileName: string
  readonly locator: Locator
  readonly excerpt: string
}

export interface FactView {
  readonly id: string
  readonly kind: FactKind
  readonly key: string
  readonly statement: string
  readonly value: string | null
  readonly state: FactState
  readonly createdAt: Date
  readonly sources: readonly FactSourceView[]
}

/** How far the reading of the project's documents is. */
export interface KnowledgeProgress {
  readonly reading: number
  readonly failed: number
  readonly compiled: number
}

/** The knowledge as a signed-in person sees it: every call runs as `viewerId`. */
export interface FactRepository {
  list(viewerId: string, projectId: string): Promise<FactView[]>
  progress(viewerId: string, projectId: string): Promise<KnowledgeProgress>
}
