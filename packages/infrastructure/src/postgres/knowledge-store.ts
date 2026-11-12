import type {
  DocumentToCompile,
  FactRepository,
  FactSourceView,
  FactView,
  KnowledgeChange,
  KnowledgeStore,
} from '@octobrief/application'
import {
  type Audience,
  type Classification,
  type DateSource,
  type DocumentKind,
  type Fact,
  type FactKind,
  type FactState,
  type KnownPerson,
  type Locator,
  locatorKey,
  rehydrateFact,
  type SourceRef,
  type Uncertain,
} from '@octobrief/domain'
import type pg from 'pg'
import { asViewer, inTransaction } from './transaction.ts'

interface FactRow {
  id: string
  project_id: string
  kind: string
  key: string
  statement: string
  value: string | null
  state: string
  origin: string
  locked_by_pm: boolean
  pm_asserted: boolean
  created_at: Date
  sources: Array<{ documentId: string; fileName: string; locator: unknown; excerpt: string }>
}

/** Facts with their sources as one JSON array each, in a stable order. */
const FACTS = `
  SELECT f.id, f.project_id, f.kind, f.key, f.statement, f.value, f.state, f.origin,
         f.locked_by_pm, f.pm_asserted, f.created_at,
         coalesce(
           (SELECT jsonb_agg(jsonb_build_object(
                     'documentId', s.document_id, 'fileName', d.file_name,
                     'locator', s.locator, 'excerpt', s.excerpt)
                     ORDER BY d.uploaded_at, d.id, s.locator_key)
              FROM fact_sources s JOIN documents d ON d.id = s.document_id
             WHERE s.fact_id = f.id),
           '[]'::jsonb) AS sources
    FROM facts f
   WHERE f.project_id = $1
   ORDER BY f.kind, f.key, f.created_at, f.id`

function toFact(row: FactRow): Fact {
  return rehydrateFact({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    key: row.key,
    statement: row.statement,
    value: row.value,
    state: row.state,
    origin: row.origin,
    lockedByPm: row.locked_by_pm,
    pmAsserted: row.pm_asserted,
    createdAt: row.created_at,
    sources: row.sources.map((s) => ({
      evidenceId: s.documentId,
      locator: s.locator,
      excerpt: s.excerpt,
    })),
  })
}

function toFactView(row: FactRow): FactView {
  return {
    id: row.id,
    kind: row.kind as FactKind,
    key: row.key,
    statement: row.statement,
    value: row.value,
    state: row.state as FactState,
    createdAt: row.created_at,
    sources: row.sources as FactSourceView[],
  }
}

async function insertFact(client: pg.PoolClient, fact: Fact, state: FactState): Promise<void> {
  await client.query(
    `INSERT INTO facts (id, project_id, kind, key, statement, value, state, origin, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      fact.id,
      fact.projectId,
      fact.kind,
      fact.key,
      fact.statement,
      fact.value,
      state,
      fact.origin,
      fact.createdAt,
    ],
  )
  await insertSources(client, fact.id, fact.sources)
}

async function insertSources(
  client: pg.PoolClient,
  factId: string,
  sources: readonly SourceRef[],
): Promise<void> {
  await client.query(
    `INSERT INTO fact_sources (fact_id, document_id, project_id, locator, locator_key, excerpt)
     SELECT f.id, s.document_id, f.project_id, s.locator, s.locator_key, s.excerpt
       FROM facts f,
            unnest($2::uuid[], $3::jsonb[], $4::text[], $5::text[])
              AS s(document_id, locator, locator_key, excerpt)
      WHERE f.id = $1
     ON CONFLICT DO NOTHING`,
    [
      factId,
      sources.map((s) => s.evidenceId),
      sources.map((s) => JSON.stringify(s.locator)),
      sources.map((s) => locatorKey(s.locator)),
      sources.map((s) => s.excerpt),
    ],
  )
}

async function applyChange(client: pg.PoolClient, change: KnowledgeChange): Promise<void> {
  switch (change.kind) {
    case 'insert':
      return insertFact(client, change.fact, 'active')
    case 'add_sources':
      return insertSources(client, change.factId, change.sources)
    case 'contest':
      await client.query(`UPDATE facts SET state = 'contested' WHERE id = $1`, [change.factId])
      return insertFact(client, change.fact, 'contested')
    case 'replace': {
      const { proposed } = change
      await client.query(
        `UPDATE facts SET statement = $2, value = $3, state = 'active' WHERE id = $1`,
        [change.factId, proposed.statement, proposed.value],
      )
      // New sources first: a fact is never left without one, even for a moment.
      await insertSources(client, change.factId, proposed.sources)
      await client.query(
        `DELETE FROM fact_sources
          WHERE fact_id = $1 AND NOT (document_id::text || '|' || locator_key = ANY($2::text[]))`,
        [change.factId, proposed.sources.map((s) => `${s.evidenceId}|${locatorKey(s.locator)}`)],
      )
    }
  }
}

interface CompilableRow {
  id: string
  project_id: string
  file_name: string
  uploaded_by: string
  kind: DocumentKind
  audience: Audience
  audience_source: Classification['audienceSource']
  document_date: Date
  date_source: DateSource
  uncertain: Uncertain[]
}

/** pgvector's text form of a vector. */
const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`

/** The worker's view: compiles documents of every project. */
export function createKnowledgeStore(pool: pg.Pool): KnowledgeStore {
  return {
    async compilable(documentId) {
      const { rows } = await pool.query<CompilableRow>(
        `SELECT id, project_id, file_name, uploaded_by, kind, audience, audience_source,
                document_date, date_source, uncertain
           FROM documents
          WHERE id = $1 AND status = 'ready' AND knowledge_status IS DISTINCT FROM 'ready'`,
        [documentId],
      )
      const row = rows[0]
      if (!row) return null
      const chunks = await pool.query<{ locator: Locator; text: string }>(
        'SELECT locator, text FROM document_chunks WHERE document_id = $1 ORDER BY position',
        [documentId],
      )
      const document: DocumentToCompile = {
        id: row.id,
        projectId: row.project_id,
        fileName: row.file_name,
        uploadedBy: row.uploaded_by,
        classification: {
          kind: row.kind,
          audience: row.audience,
          audienceSource: row.audience_source,
          dateOf: { date: row.document_date, source: row.date_source },
          uncertain: row.uncertain,
        },
        chunks: chunks.rows,
      }
      return document
    },

    async facts(projectId) {
      const { rows } = await pool.query<FactRow>(FACTS, [projectId])
      return rows.map(toFact)
    },

    async people(projectId) {
      const members = await pool.query<{ display_name: string; email: string | null }>(
        `SELECT u.display_name, u.email
           FROM project_members m JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1 ORDER BY u.display_name, u.id`,
        [projectId],
      )
      const project = await pool.query<{ client: string | null }>(
        'SELECT client FROM projects WHERE id = $1',
        [projectId],
      )
      const people: KnownPerson[] = members.rows.map((row) => ({
        displayName: row.display_name,
        ...(row.email ? { email: row.email } : {}),
      }))
      const client = project.rows[0]?.client
      if (client) people.push({ displayName: client, kind: 'organization' })
      return people
    },

    async saveEmbeddings(documentId, encoder, vectors) {
      await pool.query(
        `UPDATE document_chunks c SET embedding = v.embedding::vector, encoder = $2
           FROM unnest($3::text[]) WITH ORDINALITY AS v(embedding, position)
          WHERE c.document_id = $1 AND c.position = v.position - 1`,
        [documentId, `${encoder.model}@${encoder.digest}`, vectors.map(vectorLiteral)],
      )
    },

    async saveKnowledge(documentId, changes) {
      await inTransaction(pool, async (client) => {
        for (const change of changes) await applyChange(client, change)
        await client.query(
          `UPDATE documents
              SET knowledge_status = 'ready', knowledge_error = NULL, compiled_at = now()
            WHERE id = $1`,
          [documentId],
        )
      })
    },

    async markKnowledgeFailed(documentId, code) {
      await pool.query(
        `UPDATE documents SET knowledge_status = 'failed', knowledge_error = $2 WHERE id = $1`,
        [documentId, code],
      )
    },
  }
}

/** The web's view: every query runs as the signed-in person, under row-level security. */
export function createFactRepository(pool: pg.Pool): FactRepository {
  return {
    list(viewerId, projectId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<FactRow>(FACTS, [projectId])
        return rows.map(toFactView)
      })
    },

    progress(viewerId, projectId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<{ reading: number; failed: number; compiled: number }>(
          `SELECT (count(*) FILTER (WHERE status = 'pending' OR (status = 'ready'
                     AND knowledge_status IS DISTINCT FROM 'ready'
                     AND knowledge_status IS DISTINCT FROM 'failed')))::int AS reading,
                  (count(*) FILTER (WHERE status = 'ready' AND knowledge_status = 'failed'))::int
                    AS failed,
                  (count(*) FILTER (WHERE knowledge_status = 'ready'))::int AS compiled
             FROM documents WHERE project_id = $1`,
          [projectId],
        )
        return rows[0] ?? { reading: 0, failed: 0, compiled: 0 }
      })
    },
  }
}
