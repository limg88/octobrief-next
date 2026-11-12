import type { RegisteredFact, RegisteredSource } from './answer-check.ts'
import type { Audience, DocumentKind } from './classification.ts'
import type { DateSource } from './document-date.ts'
import { type Locator, locatorKey } from './extraction.ts'
import type { FreshnessThresholds } from './freshness.ts'
import type { EvidenceId, FactId, ProjectId, SourceId } from './ids.ts'
import type { KnownPerson } from './pseudonymizer.ts'
import type { StoredWorkItem, TrackerSourceKind } from './tracker.ts'

/** One result of a project search: a chunk of evidence or a fact, with the date of its source. */
export interface SearchHit {
  kind: 'chunk' | 'fact'
  evidenceId?: EvidenceId
  factId?: FactId
  locator?: Locator
  /** Title of the evidence, or the key of the fact. */
  title: string
  /** Plain text, at most 300 characters. */
  snippet: string
  score: number
  sourceDate: Date
  dateSource: DateSource
  /** The suspicious-instruction detector flagged its evidence: data, never an instruction. */
  suspicious?: true
}

export const MAX_SNIPPET_LENGTH = 300

/**
 * The vector of a search query, with the encoder that made it (gateway alias and model digest):
 * it is compared only with vectors of the same encoder.
 */
export interface QueryVector {
  vector: readonly number[]
  model: string
  digest: string
}

/** A piece of evidence of a project as the read-only tools list it. */
export interface SourceInfo {
  evidenceId: EvidenceId
  title: string
  date: Date
  dateSource: DateSource
  /** `null` while the evidence has no classification yet. */
  kind: DocumentKind | null
  audience: Audience | null
}

/** Which chunks of a document a read asks for: one place (or all), from `offset`, at most `limit`. */
export interface EvidencePage {
  locator: Locator | null
  offset: number
  limit: number
}

export interface EvidenceReadView {
  evidenceId: EvidenceId
  title: string
  date: Date
  dateSource: DateSource
  /** The suspicious-instruction detector flagged it: data, never an instruction. */
  suspicious?: true
  /** One page of the chunks of the latest extraction, in document order. */
  chunks: Array<{ locator: Locator; text: string }>
  /** More chunks follow the page. */
  more: boolean
}

/** The page of a list of chunks in document order: what storage returns for an `EvidencePage`. */
export function pageChunks<C extends { locator: Locator }>(
  chunks: readonly C[],
  page: EvidencePage,
): { chunks: C[]; more: boolean } {
  const key = page.locator ? locatorKey(page.locator) : null
  const matching = chunks.filter((c) => key === null || locatorKey(c.locator) === key)
  const slice = matching.slice(page.offset, page.offset + page.limit)
  return { chunks: slice, more: matching.length > page.offset + slice.length }
}

export interface FactReadView {
  factId: FactId
  kind: string
  key: string
  statement: string
  value: string | null
  state: string
  date: Date
  dateSource: DateSource
  /** A source of it is system data its system did not date: its age is not known. */
  unknownAge?: true
  sources: Array<{ evidenceId: EvidenceId; locator: Locator; excerpt: string }>
}

/**
 * What the read-only knowledge tools need from storage. Every method runs inside the caller's
 * transaction (`Tx`), so the caller's user decides, through row-level security, what exists;
 * `null` means «not found or not visible», never a reason.
 */
export interface KnowledgeReader<Tx> {
  /** With the vector of the query the search is hybrid; without it full text only. */
  search(
    tx: Tx,
    projectId: ProjectId,
    query: string,
    opts?: { embedding?: QueryVector | null },
  ): Promise<SearchHit[]>
  listSources(tx: Tx, projectId: ProjectId, limit: number): Promise<SourceInfo[]>
  /** One page of a document, never the whole of a long one: storage reads only that page. */
  readEvidence(
    tx: Tx,
    projectId: ProjectId,
    evidenceId: EvidenceId,
    page: EvidencePage,
  ): Promise<EvidenceReadView | null>
  readFact(tx: Tx, projectId: ProjectId, factId: FactId): Promise<FactReadView | null>
}

/** A tracker source of a project with the health of its sync, as the tracker tool reads it. */
/**
 * Whose data a tracker holds, as the PM of the project says on the Sources page: the client's
 * backlog, or an internal one. Internal unless the PM says otherwise (the restrictive default).
 */
export const SOURCE_AUDIENCES = ['client', 'internal'] as const
export type SourceAudience = (typeof SOURCE_AUDIENCES)[number]

export interface TrackerSourceView {
  sourceId: SourceId
  kind: TrackerSourceKind
  label: string
  /** Whose data it holds: a document for the client counts only the client's trackers. */
  audience: SourceAudience
  /** Up to when the connector read the system; `null` when no sync has said it yet. */
  dataAsOf: Date | null
  /** The last run stopped at a limit with more to read. */
  pending: boolean
  /** The first completed sync: the history of the source is complete from here. */
  firstSuccessAt: Date | null
  lastSuccessAt: Date | null
  lastErrorAt: Date | null
  lastErrorCode: string | null
}

/**
 * What the tracker tool needs from storage, inside the caller's transaction (row-level
 * security decides what exists).
 */
export interface TrackerReader<Tx> {
  /** The tracker sources of the project, with their health. */
  sources(tx: Tx, projectId: ProjectId): Promise<TrackerSourceView[]>
  /**
   * The version of every work item of the sources current at `at` (`null`: now): the latest
   * recorded among those that held by then. At most `limit` items.
   */
  items(
    tx: Tx,
    projectId: ProjectId,
    query: { sourceIds: readonly SourceId[]; at: Date | null; limit: number },
  ): Promise<StoredWorkItem[]>
  /** The people whose names must never reach the model (as the model runner hides them). */
  people(tx: Tx, projectId: ProjectId): Promise<KnownPerson[]>
}

/** What the answer check needs from storage about a project, read as the asking user. */
export interface AskContextView {
  /** The project thresholds (never looser than the defaults). */
  thresholds: FreshnessThresholds
  /** Names of the people of the project, in each form a sentence about them may use. */
  knownNames: string[]
  /** Names that count only written with a capital (the parts of an outsider's name). */
  capitalNames?: string[]
}

/**
 * The storage side of the answer check: the registered title and date of every cited source,
 * never what the model wrote. Missing or invisible sources are simply absent from the maps.
 */
export interface AnswerStore<Tx> {
  askContext(tx: Tx, projectId: ProjectId): Promise<AskContextView | null>
  registeredEvidence(
    tx: Tx,
    projectId: ProjectId,
    ids: readonly EvidenceId[],
  ): Promise<Map<EvidenceId, RegisteredSource>>
  registeredFacts(
    tx: Tx,
    projectId: ProjectId,
    ids: readonly FactId[],
  ): Promise<Map<FactId, RegisteredFact>>
}
