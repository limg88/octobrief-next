import {
  type Audience,
  type DateSource,
  DEFAULT_FRESHNESS,
  type DocumentKind,
  detectSuspicious,
  type FactKind,
  type FactState,
  type Locator,
  type ProjectId,
  type SourceId,
  type SuspiciousHit,
} from '@octobrief/domain'
import {
  type CitedSources,
  factPolicy,
  freshnessPolicyOf,
  isInternalOnly,
  isSystemDataSource,
  type OriginSource,
  type RecipeDataReader,
  type RecipeEvidenceView,
  type RecipeFactView,
  type RecipeSystemView,
  recipeSourceKind,
} from '@octobrief/domain/recipe'
import type pg from 'pg'
import { trackerReader } from './ask-store.ts'

// What the gathering of a recipe reads: the documents, facts, tracker items and system rows of
// ONE project. Every statement names the project, so the worker never reads across projects.

type Tx = pg.PoolClient

/** Documents get one classification here: there is no history of reclassifications yet. */
const CLASSIFICATION_VERSION = 1
/** A fact is stored once: the PM cannot edit facts yet, so it has one version. */
const FACT_VERSION = 1
const COMPILE_LANG = 'it'

interface EvidenceRow {
  id: string
  file_name: string
  source_id: string | null
  source_kind: 'm365' | 'dwsi' | 'files' | 'jira' | 'ado' | null
  sha256: string
  kind: DocumentKind | null
  audience: Audience | null
  document_date: Date
  date_source: DateSource
  origin_at: Date | null
  project_id: string
}

function originSourceOf(row: EvidenceRow): OriginSource {
  if (row.date_source === 'pm') return 'pm'
  return row.origin_at === null ? 'acquisition' : 'system'
}

function toEvidence(row: EvidenceRow): RecipeEvidenceView {
  const sourceKind = recipeSourceKind(row.source_kind)
  return {
    id: row.id,
    title: row.file_name,
    // A manual upload has no source of its own: the project stands for it.
    sourceId: row.source_id ?? row.project_id,
    sourceKind,
    contentHash: `sha256:${row.sha256}`,
    kind: row.kind,
    audience: row.audience,
    classificationVersion: CLASSIFICATION_VERSION,
    date: row.document_date,
    dateSource: row.date_source,
    originSource: originSourceOf(row),
    policy: freshnessPolicyOf(sourceKind, row.kind),
    removedAt: null,
  }
}

async function evidenceViews(tx: Tx, projectId: string): Promise<RecipeEvidenceView[]> {
  const { rows } = await tx.query<EvidenceRow>(
    `SELECT d.id, d.file_name, d.source_id, s.kind AS source_kind, d.sha256, d.kind, d.audience,
            d.document_date, d.date_source, d.origin_at, d.project_id
       FROM documents d LEFT JOIN sources s ON s.id = d.source_id
      WHERE d.project_id = $1 AND d.status = 'ready'
      ORDER BY d.document_date DESC, d.id`,
    [projectId],
  )
  return rows.map(toEvidence)
}

interface FactRow {
  id: string
  kind: FactKind
  key: string
  statement: string
  value: string | null
  state: FactState
  locked_by_pm: boolean
  pm_asserted: boolean
  created_at: Date
  newest: Date | null
  sources: Array<{ evidenceId: string; locator: Locator }>
}

const FACTS = `
  SELECT f.id, f.kind, f.key, f.statement, f.value, f.state, f.locked_by_pm, f.pm_asserted,
         f.created_at,
         (SELECT max(d.document_date) FROM fact_sources s
            JOIN documents d ON d.id = s.document_id WHERE s.fact_id = f.id) AS newest,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'evidenceId', s.document_id, 'locator', s.locator)
                     ORDER BY s.document_id, s.locator_key)
                     FROM fact_sources s WHERE s.fact_id = f.id), '[]'::jsonb) AS sources
    FROM facts f`

export const recipeDataReader: RecipeDataReader<Tx> = {
  async project(tx, projectId) {
    const found = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
    return found.rowCount === 0 ? null : { thresholds: DEFAULT_FRESHNESS }
  },

  evidence: (tx, projectId) => evidenceViews(tx, projectId),

  async firstLocators(tx, projectId, ids) {
    const { rows } = await tx.query<{ document_id: string; locator: Locator }>(
      `SELECT DISTINCT ON (document_id) document_id, locator FROM document_chunks
        WHERE project_id = $1 AND document_id::text = ANY($2::text[])
        ORDER BY document_id, position`,
      [projectId, ids],
    )
    return new Map(rows.map((row) => [row.document_id, row.locator]))
  },

  trackerSources: (tx, projectId) => trackerReader.sources(tx, projectId),

  trackerItems: (tx, projectId, query) => trackerReader.items(tx, projectId, query),

  async systemViews(tx, projectId, view): Promise<RecipeSystemView[]> {
    // The rows of a view of a system, with the newest document its source brought: what a
    // value read from them cites.
    const { rows } = await tx.query<{
      source_id: string
      source_name: string
      perimeter: string
      extracted_at: Date
      source_synced_at: Date | null
      data_as_of: Date | null
      evidence_id: string
      evidence_title: string
      rows: Array<{ key: string; values: Record<string, unknown> }>
    }>(
      `SELECT r.source_id, s.name AS source_name, r.perimeter, max(r.extracted_at) AS extracted_at,
              max(r.source_synced_at) AS source_synced_at, s.data_as_of,
              e.id AS evidence_id, e.file_name AS evidence_title,
              jsonb_agg(jsonb_build_object('key', r.key, 'values', r."values") ORDER BY r.key)
                AS rows
         FROM system_rows r
         JOIN sources s ON s.id = r.source_id
         JOIN LATERAL (SELECT d.id, d.file_name FROM documents d
                        WHERE d.source_id = r.source_id AND d.status = 'ready'
                        ORDER BY d.document_date DESC, d.id LIMIT 1) e ON true
        WHERE r.project_id = $1 AND r.view = $2
        GROUP BY r.source_id, s.name, s.data_as_of, r.perimeter, e.id, e.file_name
        ORDER BY r.source_id, r.perimeter`,
      [projectId, view],
    )
    return rows.map((row) => ({
      sourceId: row.source_id as SourceId,
      sourceLabel: row.source_name,
      scope: row.perimeter,
      view,
      // One extraction per source, perimeter and view: its rows are replaced when read again.
      extractionId: `${row.source_id}:${row.perimeter}:${view}`,
      evidenceId: row.evidence_id,
      evidenceTitle: row.evidence_title,
      extractedAt: row.extracted_at,
      sourceSyncedAt: row.source_synced_at,
      dataAsOf: row.data_as_of,
      rows: row.rows,
    }))
  },

  async facts(tx, projectId, kind): Promise<RecipeFactView[]> {
    const { rows } = await tx.query<FactRow>(
      `${FACTS} WHERE f.project_id = $1 AND f.kind = $2 AND f.state <> 'superseded'
        ORDER BY f.key, f.created_at, f.id`,
      [projectId, kind],
    )
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      statement: row.statement,
      value: row.value,
      state: row.state,
      lockedByPm: row.locked_by_pm,
      pmAsserted: row.pm_asserted,
      version: FACT_VERSION,
      date: row.newest ?? row.created_at,
      unknownAge: row.newest === null,
      sources: row.sources,
      // The other facts of the same subject that say otherwise: the sides of a contradiction.
      candidates:
        row.state === 'contested'
          ? rows
              .filter((other) => other.key === row.key && other.id !== row.id)
              .map((other) => ({
                statement: other.statement,
                value: other.value,
                sources: other.sources,
              }))
          : [],
    }))
  },
}

/**
 * What the gates know of the documents and facts a text cites: their audience and how their age
 * is judged. A document without a classification is an untyped internal one; a fact is for the
 * client only when all its sources are.
 */
export async function citedSources(
  tx: Tx,
  projectId: ProjectId,
  ids: { evidenceIds: readonly string[]; factIds: readonly string[] },
): Promise<CitedSources> {
  const views = new Map((await evidenceViews(tx, projectId)).map((e) => [e.id, e]))
  const evidence: Record<string, CitedSources['evidence'][string]> = {}
  const know = (e: RecipeEvidenceView) => {
    evidence[e.id] = {
      audience: {
        kind: e.kind ?? 'generic',
        audience: e.audience ?? 'internal',
        fromSystem: isSystemDataSource(e.sourceKind),
        title: e.title,
      },
      policy: e.policy,
      sourceKind: e.sourceKind,
    }
  }
  for (const id of new Set(ids.evidenceIds)) {
    const e = views.get(id)
    if (e) know(e)
  }
  const facts: Record<string, CitedSources['facts'][string]> = {}
  if (ids.factIds.length === 0) return { evidence, facts }
  const { rows } = await tx.query<FactRow>(
    `${FACTS} WHERE f.project_id = $1 AND f.id::text = ANY($2::text[])`,
    [projectId, [...new Set(ids.factIds)]],
  )
  for (const fact of rows) {
    const sourcesOf = fact.sources.flatMap((s) => {
      const e = views.get(s.evidenceId)
      return e ? [e] : []
    })
    if (!fact.pm_asserted && sourcesOf.length === 0) continue
    for (const e of sourcesOf) know(e)
    const clientOnly =
      sourcesOf.length > 0 &&
      sourcesOf.every(
        (e) =>
          e.kind !== null &&
          e.audience === 'client' &&
          !isInternalOnly(e.kind, isSystemDataSource(e.sourceKind)),
      )
    facts[fact.id] = {
      audience: { kind: fact.kind, clientOnly },
      policy: factPolicy(
        sourcesOf.map((e) => ({ freshnessPolicy: e.policy, superseded: false })),
        fact.pm_asserted,
      ).freshnessPolicy,
    }
  }
  return { evidence, facts }
}

/** The sentences shaped like instructions in these documents, with where each one is. */
export async function suspiciousHits(
  tx: Tx,
  projectId: ProjectId,
  evidenceIds: readonly string[],
): Promise<Record<string, SuspiciousHit[]>> {
  const out: Record<string, SuspiciousHit[]> = {}
  if (evidenceIds.length === 0) return out
  const { rows } = await tx.query<{ document_id: string; locator: Locator; text: string }>(
    `SELECT c.document_id, c.locator, c.text
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.project_id = $1 AND d.suspicious AND c.document_id::text = ANY($2::text[])
      ORDER BY c.document_id, c.position`,
    [projectId, evidenceIds],
  )
  const byDocument = new Map<string, Array<{ locator: Locator; text: string }>>()
  for (const row of rows) {
    byDocument.set(row.document_id, [...(byDocument.get(row.document_id) ?? []), row])
  }
  for (const [id, chunks] of byDocument) {
    const hits = detectSuspicious(chunks, COMPILE_LANG).map((hit) => {
      const locator = chunks[hit.chunkIndex]?.locator
      return locator ? { ...hit, locator } : hit
    })
    if (hits.length > 0) out[id] = hits
  }
  return out
}
