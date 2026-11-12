import type { Audience, DocumentKind } from '../classification.ts'
import type { DocumentDate } from '../document-date.ts'
import type { Locator } from '../extraction.ts'
import type { FreshnessPolicy, FreshnessThresholds } from '../freshness.ts'
import type { OriginSource } from '../freshness-policy.ts'
import type { EvidenceAudience, FactAudience } from '../gate/audience.ts'
import type { ProjectId, SourceId } from '../ids.ts'
import type { FactKind, FactState } from '../knowledge.ts'
import type { ContentHash } from '../pseudonym.ts'
import type { TrackerSourceView } from '../search.ts'
import type { StoredWorkItem } from '../tracker.ts'
import type { DataCategory } from './categories.ts'
import type { ParameterValues } from './gathered.ts'
import { canonicalHash } from './hash.ts'
import type { ProjectRecipeSettings } from './project-settings.ts'
import type { SourceKind } from './source-kinds.ts'
import type { TemplateFormat } from './template.ts'

// What the gathering of a recipe reads from storage, and the snapshot of the inputs a run is
// saved with. Every method runs in the caller's transaction, so row-level security decides what
// exists; the perimeter of each source and the removals at the source are applied by storage.

/** A piece of evidence of the project, as a recipe reads it. */
export interface RecipeEvidenceView {
  id: string
  title: string
  sourceId: string
  sourceKind: SourceKind
  /** The fingerprint of its content: evidence never changes, a new version is new evidence. */
  contentHash: string
  /** `null` while it has no classification. */
  kind: DocumentKind | null
  audience: Audience | null
  classificationVersion: number | null
  /** Its registered date, and who dated it. */
  date: Date
  dateSource: DocumentDate['source']
  originSource: OriginSource
  policy: FreshnessPolicy
  /** Its source said it is gone (the latest removal after its latest version): never read. */
  removedAt: Date | null
}

/** The latest extraction of a view of the data warehouse, for one option of a perimeter. */
export interface RecipeSystemView {
  sourceId: SourceId
  sourceLabel: string
  scope: string
  view: string
  extractionId: string
  /** The evidence that lists the rows. */
  evidenceId: string
  evidenceTitle: string
  /** When the extraction read the view. */
  extractedAt: Date
  /** When the warehouse last synchronized the view; null when not deduced. */
  sourceSyncedAt: Date | null
  /** How old the data is; null when the warehouse does not date it. */
  dataAsOf: Date | null
  rows: ReadonlyArray<{ key: string; values: Readonly<Record<string, unknown>> }>
}

/** A fact of the project at its current version, as a recipe reads it. */
export interface RecipeFactView {
  id: string
  kind: FactKind
  key: string
  statement: string
  value: string | null
  state: FactState
  /** The PM corrected it: its value wins over any later extraction. */
  lockedByPm: boolean
  /** Stated by the PM without evidence. */
  pmAsserted: boolean
  version: number
  /** How it is dated (the PM's version, else its latest dated source). */
  date: Date
  /** A source of it is system data its system did not date: its age is «non dedotto». */
  unknownAge: boolean
  sources: ReadonlyArray<{ evidenceId: string; locator: Locator }>
  /** The other sides of an open contradiction: what a newer piece of evidence says instead. */
  candidates: ReadonlyArray<{
    statement: string
    value: string | null
    sources: ReadonlyArray<{ evidenceId: string; locator: Locator }>
  }>
}

/** The storage side of the gathering. */
export interface RecipeDataReader<Tx> {
  /** The project thresholds; null when the project is not visible. */
  project(tx: Tx, projectId: ProjectId): Promise<{ thresholds: FreshnessThresholds } | null>
  /** Every visible piece of evidence of the project, removed ones marked. */
  evidence(tx: Tx, projectId: ProjectId): Promise<RecipeEvidenceView[]>
  /** The first place of the text of each of these pieces of evidence, when it has a text. */
  firstLocators(
    tx: Tx,
    projectId: ProjectId,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, Locator>>
  trackerSources(tx: Tx, projectId: ProjectId): Promise<TrackerSourceView[]>
  /** The work items of the sources as they were at `at` (within each source's perimeter). */
  trackerItems(
    tx: Tx,
    projectId: ProjectId,
    query: { sourceIds: readonly SourceId[]; at: Date; limit: number },
  ): Promise<StoredWorkItem[]>
  /** The latest extraction of a view for every option of the perimeter of every warehouse. */
  systemViews(tx: Tx, projectId: ProjectId, view: string): Promise<RecipeSystemView[]>
  /** The current facts of a kind (superseded ones excluded), with their open contradictions. */
  facts(tx: Tx, projectId: ProjectId, kind: FactKind): Promise<RecipeFactView[]>
}

export const INPUT_SNAPSHOT_SCHEMA = 'octobrief.input-snapshot/1' as const

/**
 * What the files of a run are made with, as the run found it: the configuration of the recipe in
 * the project (its fingerprint is `settingsHash` when one was saved) and the template of its
 * binary format, by content. The render uses these, never the configuration of a later moment.
 */
export interface SnapshotRender {
  settings: ProjectRecipeSettings
  /** Null for a recipe with no binary format, or when no template was found. */
  template: { slug: string; format: TemplateFormat; contentHash: string } | null
}

/**
 * The inputs of a run, saved with it: the same snapshot gives the same skeleton. Lists are
 * sorted, so the snapshot of the same inputs is the same whatever the order of the reads.
 */
export interface InputSnapshot {
  schema: typeof INPUT_SNAPSHOT_SCHEMA
  /** ISO instant the data was read at: the tracker is read as of it. */
  referenceTime: string
  recipe: { slug: string; version: string; hash: string }
  modelAlias: string | null
  parameters: ParameterValues
  /** The fingerprint of the configuration of the recipe in the project. */
  settingsHash: string | null
  /** Absent in the snapshots of runs made before the files were rendered from them. */
  render?: SnapshotRender
  policies: {
    freshness: FreshnessThresholds
    /** The categories the client version admits. */
    clientCategories: readonly DataCategory[]
  }
  /** The evidence read: content, classification and what the document shows of it. */
  evidence: ReadonlyArray<{
    id: string
    contentHash: string
    classificationVersion: number | null
    title: string
    date: string
    dateSource: DocumentDate['source']
  }>
  /** Each tracker read, the instant it was read at and how old its data was. */
  tracker: ReadonlyArray<{ sourceId: string; at: string; dataAsOf: string | null }>
  /** Every row of the warehouse read, with its value and its dates. */
  systemRows: ReadonlyArray<{
    sourceId: string
    scope: string
    view: string
    extractionId: string
    rowKey: string
    /** The fingerprint of the values as the warehouse gave them. */
    valuesHash: string
    /** The values themselves, for at most a few thousand rows a run. */
    values?: Readonly<Record<string, unknown>>
    dataAsOf: string | null
    extractedAt: string
    sourceSyncedAt: string | null
  }>
  facts: ReadonlyArray<{ id: string; version: number; state: FactState; lockedByPm: boolean }>
  /** The evidence its source removed, left out of the run. */
  removals: ReadonlyArray<{ evidenceId: string; removedAt: string }>
}

/** The fingerprint of a snapshot of the inputs. */
export function inputSnapshotHash(snapshot: InputSnapshot): ContentHash {
  return canonicalHash(snapshot)
}

/**
 * What the gates know of the evidence and facts the writer read through the tools, beyond what
 * the gathering read: their audience (for the client gate) and how their age is judged.
 */
export interface CitedSources {
  evidence: Readonly<
    Record<string, { audience: EvidenceAudience; policy: FreshnessPolicy; sourceKind: SourceKind }>
  >
  facts: Readonly<Record<string, { audience: FactAudience; policy: FreshnessPolicy }>>
}
