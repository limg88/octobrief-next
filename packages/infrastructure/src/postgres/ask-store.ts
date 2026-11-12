import {
  type AnswerStore,
  type AskContextView,
  type DateSource,
  DEFAULT_FRESHNESS,
  type DocumentKind,
  type EvidenceId,
  type EvidenceReadView,
  type FactId,
  type FactReadView,
  factPolicy,
  type KnowledgeReader,
  type KnownPerson,
  knownNameForms,
  type Locator,
  MAX_SNIPPET_LENGTH,
  type ProjectId,
  pageChunks,
  type RegisteredFact,
  type RegisteredSource,
  type SearchHit,
  type SourceId,
  type SourcePolicy,
  type StoredWorkItem,
  sourcePolicies,
  type TrackerReader,
  type TrackerSourceKind,
} from '@octobrief/domain'
import type pg from 'pg'

// What a question reads: the documents and facts of ONE project. Every statement names the
// project, so the worker (which sees every project) never reads across projects.

/** Hits of each ranked list, and of the fused result. */
const SEARCH_LIMIT = 20
/** Reciprocal rank fusion: how much the first places count over the following ones. */
export const RRF_K = 60

type Tx = pg.PoolClient

interface HitRow {
  kind: 'chunk' | 'fact'
  document_id: string | null
  fact_id: string | null
  locator: Locator | null
  title: string
  snippet: string
  source_date: Date
  date_source: DateSource
  suspicious: boolean
}

/** The lexemes of the question, any of them: a question is not a list of required words. */
const TSQUERY = `
  (SELECT to_tsquery('simple', string_agg('''' || replace(lexeme, '''', '''''') || '''', ' | '))
     FROM unnest(to_tsvector('italian', $2)))`

const CHUNKS_BY_WORDS = `
  SELECT 'chunk' AS kind, c.document_id, NULL::uuid AS fact_id, c.locator, d.file_name AS title,
         left(c.text, ${MAX_SNIPPET_LENGTH}) AS snippet, d.document_date AS source_date,
         d.date_source, d.suspicious
    FROM document_chunks c JOIN documents d ON d.id = c.document_id, ${TSQUERY} AS q(tsq)
   WHERE c.project_id = $1 AND d.status = 'ready' AND c.search @@ q.tsq
   ORDER BY ts_rank_cd(c.search, q.tsq) DESC, d.document_date DESC, c.document_id, c.position
   LIMIT ${SEARCH_LIMIT}`

/** A fact is as old as the newest document that states it. */
const FACT_DATING = `
  LATERAL (SELECT d.document_date, d.date_source
             FROM fact_sources s JOIN documents d ON d.id = s.document_id
            WHERE s.fact_id = f.id ORDER BY d.document_date DESC LIMIT 1) AS dated`

const FACTS_BY_WORDS = `
  SELECT 'fact' AS kind, NULL::uuid AS document_id, f.id AS fact_id, NULL::jsonb AS locator,
         f.key AS title,
         left(f.statement || coalesce(' (' || f.value || ')', ''), ${MAX_SNIPPET_LENGTH}) AS snippet,
         dated.document_date AS source_date, dated.date_source, false AS suspicious
    FROM facts f, ${FACT_DATING}, ${TSQUERY} AS q(tsq)
   WHERE f.project_id = $1 AND f.state <> 'superseded' AND f.search @@ q.tsq
   ORDER BY ts_rank_cd(f.search, q.tsq) DESC, f.id
   LIMIT ${SEARCH_LIMIT}`

const CHUNKS_BY_MEANING = `
  SELECT 'chunk' AS kind, c.document_id, NULL::uuid AS fact_id, c.locator, d.file_name AS title,
         left(c.text, ${MAX_SNIPPET_LENGTH}) AS snippet, d.document_date AS source_date,
         d.date_source, d.suspicious
    FROM document_chunks c JOIN documents d ON d.id = c.document_id
   WHERE c.project_id = $1 AND d.status = 'ready' AND c.encoder = $3 AND c.embedding IS NOT NULL
   ORDER BY c.embedding <=> $2::vector, c.document_id, c.position
   LIMIT ${SEARCH_LIMIT}`

const hitKey = (row: HitRow) =>
  row.kind === 'fact' ? `f:${row.fact_id}` : `c:${row.document_id}:${JSON.stringify(row.locator)}`

function toHit(row: HitRow, score: number): SearchHit {
  return {
    kind: row.kind,
    ...(row.document_id ? { evidenceId: row.document_id as EvidenceId } : {}),
    ...(row.fact_id ? { factId: row.fact_id as FactId } : {}),
    ...(row.locator ? { locator: row.locator } : {}),
    title: row.title,
    snippet: row.snippet,
    score,
    sourceDate: row.source_date,
    dateSource: row.date_source,
    ...(row.suspicious ? { suspicious: true as const } : {}),
  }
}

/** Several ranked lists as one: each hit scores by its places (reciprocal rank fusion). */
export function fuse(lists: ReadonlyArray<readonly HitRow[]>): SearchHit[] {
  const scored = new Map<string, { row: HitRow; score: number }>()
  for (const list of lists) {
    list.forEach((row, place) => {
      const key = hitKey(row)
      const entry = scored.get(key) ?? { row, score: 0 }
      entry.score += 1 / (RRF_K + place + 1)
      scored.set(key, entry)
    })
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_LIMIT)
    .map(({ row, score }) => toHit(row, score))
}

export const knowledgeReader: KnowledgeReader<Tx> = {
  async search(tx, projectId, query, opts) {
    const byWords = [
      (await tx.query<HitRow>(CHUNKS_BY_WORDS, [projectId, query])).rows,
      (await tx.query<HitRow>(FACTS_BY_WORDS, [projectId, query])).rows,
    ]
    const embedding = opts?.embedding
    if (!embedding) return fuse(byWords)
    const byMeaning = await tx.query<HitRow>(CHUNKS_BY_MEANING, [
      projectId,
      `[${embedding.vector.join(',')}]`,
      `${embedding.model}@${embedding.digest}`,
    ])
    return fuse([...byWords, byMeaning.rows])
  },

  async listSources(tx, projectId, limit) {
    const { rows } = await tx.query<{
      id: string
      file_name: string
      document_date: Date
      date_source: DateSource
      kind: DocumentKind | null
      audience: 'internal' | 'client' | null
    }>(
      `SELECT id, file_name, document_date, date_source, kind, audience FROM documents
        WHERE project_id = $1 AND status = 'ready'
        ORDER BY document_date DESC, id LIMIT $2`,
      [projectId, limit],
    )
    return rows.map((row) => ({
      evidenceId: row.id as EvidenceId,
      title: row.file_name,
      date: row.document_date,
      dateSource: row.date_source,
      kind: row.kind,
      audience: row.audience,
    }))
  },

  async readEvidence(tx, projectId, evidenceId, page): Promise<EvidenceReadView | null> {
    const found = await tx.query<{
      file_name: string
      document_date: Date
      date_source: DateSource
      suspicious: boolean
    }>(
      `SELECT file_name, document_date, date_source, suspicious FROM documents
        WHERE id = $1 AND project_id = $2 AND status = 'ready'`,
      [evidenceId, projectId],
    )
    const document = found.rows[0]
    if (!document) return null
    const all = await tx.query<{ locator: Locator; text: string }>(
      'SELECT locator, text FROM document_chunks WHERE document_id = $1 ORDER BY position',
      [evidenceId],
    )
    return {
      evidenceId,
      title: document.file_name,
      date: document.document_date,
      dateSource: document.date_source,
      ...(document.suspicious ? { suspicious: true as const } : {}),
      ...pageChunks(all.rows, page),
    }
  },

  async readFact(tx, projectId, factId): Promise<FactReadView | null> {
    const { rows } = await tx.query<{
      kind: string
      key: string
      statement: string
      value: string | null
      state: string
      created_at: Date
      sources: Array<{
        documentId: string
        locator: Locator
        excerpt: string
        date: string
        dateSource: DateSource
      }>
    }>(
      `SELECT f.kind, f.key, f.statement, f.value, f.state, f.created_at,
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                          'documentId', s.document_id, 'locator', s.locator,
                          'excerpt', s.excerpt, 'date', d.document_date,
                          'dateSource', d.date_source) ORDER BY d.document_date DESC, d.id)
                          FROM fact_sources s JOIN documents d ON d.id = s.document_id
                         WHERE s.fact_id = f.id), '[]'::jsonb) AS sources
         FROM facts f WHERE f.id = $1 AND f.project_id = $2`,
      [factId, projectId],
    )
    const fact = rows[0]
    if (!fact) return null
    const newest = fact.sources[0]
    return {
      factId,
      kind: fact.kind,
      key: fact.key,
      statement: fact.statement,
      value: fact.value,
      state: fact.state,
      date: newest ? new Date(newest.date) : fact.created_at,
      dateSource: newest?.dateSource ?? 'acquisition',
      ...(newest ? {} : { unknownAge: true as const }),
      sources: fact.sources.map((source) => ({
        evidenceId: source.documentId as EvidenceId,
        locator: source.locator,
        excerpt: source.excerpt,
      })),
    }
  },
}

/** People and organizations of a project: members, the client and who the sources named. */
export async function projectPeople(
  db: Pick<pg.Pool, 'query'>,
  projectId: string,
): Promise<KnownPerson[]> {
  const members = await db.query<{ display_name: string; email: string | null }>(
    `SELECT u.display_name, u.email
       FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 ORDER BY u.display_name, u.id`,
    [projectId],
  )
  const project = await db.query<{ client: string | null }>(
    'SELECT client FROM projects WHERE id = $1',
    [projectId],
  )
  const people: KnownPerson[] = members.rows.map((row) => ({
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
  }))
  const client = project.rows[0]?.client
  if (client) people.push({ displayName: client, kind: 'organization' })
  const named = await db.query<{ display_name: string; email: string; untrusted: boolean }>(
    `SELECT display_name, email, untrusted FROM project_people
      WHERE project_id = $1 ORDER BY display_name, email`,
    [projectId],
  )
  for (const row of named.rows) {
    people.push({
      displayName: row.display_name,
      ...(row.email ? { email: row.email } : {}),
      trust: row.untrusted ? 'untrusted' : 'seen',
    })
  }
  return people
}

interface PolicyRow {
  id: string
  file_name: string
  document_date: Date
  date_source: DateSource
  kind: DocumentKind | null
  source_kind: 'm365' | 'dwsi' | 'files' | 'jira' | 'ado' | null
}

/** Every readable document of the project with its freshness policy. */
async function documentPolicies(
  tx: Tx,
  projectId: string,
): Promise<Map<string, PolicyRow & SourcePolicy>> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT d.id, d.file_name, d.document_date, d.date_source, d.kind, s.kind AS source_kind
       FROM documents d LEFT JOIN sources s ON s.id = d.source_id
      WHERE d.project_id = $1 AND d.status = 'ready'`,
    [projectId],
  )
  const policies = sourcePolicies(
    rows.map((row) => ({
      id: row.id,
      sourceKind: row.source_kind ?? 'manual_upload',
      documentKind: row.kind,
      date: row.document_date,
    })),
  )
  return new Map(rows.map((row) => [row.id, { ...row, ...(policies.get(row.id) as SourcePolicy) }]))
}

export const answerStore: AnswerStore<Tx> = {
  async askContext(tx, projectId): Promise<AskContextView | null> {
    const found = await tx.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
    if (found.rowCount === 0) return null
    const people = (await projectPeople(tx, projectId)).filter((p) => p.kind !== 'organization')
    return {
      thresholds: DEFAULT_FRESHNESS,
      knownNames: [...new Set(people.flatMap((p) => knownNameForms(p).forms))],
      capitalNames: [...new Set(people.flatMap((p) => knownNameForms(p).capitalForms))],
    }
  },

  async registeredEvidence(tx, projectId, ids) {
    const out = new Map<EvidenceId, RegisteredSource>()
    if (ids.length === 0) return out
    const documents = await documentPolicies(tx, projectId)
    for (const id of ids) {
      const document = documents.get(id)
      if (!document) continue
      out.set(id, {
        title: document.file_name,
        sourceDate: document.document_date,
        dateSource: document.date_source,
        freshnessPolicy: document.freshnessPolicy,
        superseded: document.superseded,
      })
    }
    return out
  },

  async registeredFacts(tx, projectId, ids) {
    const out = new Map<FactId, RegisteredFact>()
    if (ids.length === 0) return out
    const documents = await documentPolicies(tx, projectId)
    const { rows } = await tx.query<{
      id: string
      statement: string
      state: string
      pm_asserted: boolean
      document_ids: string[]
    }>(
      `SELECT f.id, f.statement, f.state, f.pm_asserted,
              coalesce((SELECT array_agg(DISTINCT s.document_id::text) FROM fact_sources s
                         WHERE s.fact_id = f.id), '{}') AS document_ids
         FROM facts f
        WHERE f.project_id = $1 AND f.id::text = ANY($2::text[]) AND f.state <> 'superseded'`,
      [projectId, ids],
    )
    for (const fact of rows) {
      const sources = fact.document_ids.flatMap((id) => {
        const document = documents.get(id)
        return document ? [document] : []
      })
      const newest = [...sources].sort(
        (a, b) => b.document_date.getTime() - a.document_date.getTime(),
      )[0]
      out.set(fact.id as FactId, {
        ...factPolicy(sources, fact.pm_asserted),
        title: newest?.file_name ?? fact.statement,
        sourceDate: newest?.document_date ?? null,
        dateSource: newest?.date_source ?? 'acquisition',
        pmAsserted: fact.pm_asserted,
        contested: fact.state === 'contested',
      })
    }
    return out
  },
}

export const trackerReader: TrackerReader<Tx> = {
  async sources(tx, projectId) {
    const { rows } = await tx.query<{
      id: string
      kind: TrackerSourceKind
      name: string
      data_as_of: Date | null
      last_sync_at: Date | null
      last_error: string | null
    }>(
      `SELECT id, kind, name, data_as_of, last_sync_at, last_error FROM sources
        WHERE project_id = $1 AND kind IN ('jira', 'ado') ORDER BY name, id`,
      [projectId],
    )
    return rows.map((row) => {
      const failed = row.last_error !== null
      return {
        sourceId: row.id as SourceId,
        kind: row.kind,
        label: row.name,
        audience: 'internal' as const,
        dataAsOf: row.data_as_of,
        pending: row.last_sync_at === null,
        firstSuccessAt: row.data_as_of,
        lastSuccessAt: failed ? row.data_as_of : row.last_sync_at,
        lastErrorAt: failed ? row.last_sync_at : null,
        lastErrorCode: row.last_error,
      }
    })
  },

  async items(tx, projectId: ProjectId, query): Promise<StoredWorkItem[]> {
    if (query.sourceIds.length === 0 || query.limit <= 0) return []
    const { rows } = await tx.query<{
      source_id: string
      kind: TrackerSourceKind
      external_id: string
      record: Record<string, unknown>
      external_url: string | null
    }>(
      `SELECT t.source_id, s.kind, t.external_id, t.record, t.external_url
         FROM tracker_items t JOIN sources s ON s.id = t.source_id
        WHERE t.project_id = $1 AND t.source_id::text = ANY($2::text[]) AND t.removed_at IS NULL
        ORDER BY t.source_id, t.external_id LIMIT $3`,
      [projectId, query.sourceIds, query.limit],
    )
    return rows.map((row) => ({
      sourceId: row.source_id as SourceId,
      kind: row.kind,
      externalId: row.external_id,
      fields: row.record,
      url: row.external_url,
    }))
  },

  people: (tx, projectId) => projectPeople(tx, projectId),
}
