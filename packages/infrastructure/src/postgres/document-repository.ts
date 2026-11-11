import type {
  DocumentProcessingStore,
  DocumentRepository,
  DocumentToProcess,
} from '@octobrief/application'
import type {
  Audience,
  Classification,
  DateSource,
  DocumentKind,
  DocumentStatus,
  DocumentSummary,
  ExtractionWarning,
  Locator,
  Uncertain,
} from '@octobrief/domain'
import type pg from 'pg'
import { asViewer, inTransaction } from './transaction.ts'

interface DocumentRow {
  id: string
  project_id: string
  file_name: string
  media_type: string
  size_bytes: string
  status: DocumentStatus
  kind: DocumentKind | null
  audience: Audience | null
  audience_source: Classification['audienceSource'] | null
  document_date: Date | null
  date_source: DateSource | null
  uncertain: Uncertain[]
  warnings: ExtractionWarning[]
  chunk_count: number
  uploaded_by: string
  uploader_name: string
  uploaded_at: Date
}

const SUMMARY = `
  SELECT d.id, d.project_id, d.file_name, d.media_type, d.size_bytes, d.status, d.kind,
         d.audience, d.audience_source, d.document_date, d.date_source, d.uncertain, d.warnings,
         d.chunk_count, d.uploaded_by, u.display_name AS uploader_name, d.uploaded_at
    FROM documents d JOIN users u ON u.id = d.uploaded_by`

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    kind: row.kind,
    audience: row.audience,
    audienceSource: row.audience_source,
    documentDate: row.document_date,
    dateSource: row.date_source,
    uncertain: row.uncertain,
    warnings: row.warnings,
    chunkCount: row.chunk_count,
    uploadedBy: row.uploaded_by,
    uploaderName: row.uploader_name,
    uploadedAt: row.uploaded_at,
  }
}

async function summaryById(client: pg.PoolClient, id: string): Promise<DocumentSummary | null> {
  const { rows } = await client.query<DocumentRow>(`${SUMMARY} WHERE d.id = $1`, [id])
  return rows[0] ? toSummary(rows[0]) : null
}

/** The web's view: every query runs as the signed-in person, under row-level security. */
export function createDocumentRepository(pool: pg.Pool): DocumentRepository {
  return {
    create(viewerId, document) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO documents
             (project_id, file_name, media_type, size_bytes, sha256, blob_key, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, sha256) DO NOTHING
           RETURNING id`,
          [
            document.projectId,
            document.fileName,
            document.mediaType,
            document.sizeBytes,
            document.sha256,
            document.blobKey,
            document.uploadedBy,
          ],
        )
        return rows[0] ? summaryById(client, rows[0].id) : null
      })
    },

    list(viewerId, projectId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<DocumentRow>(
          `${SUMMARY} WHERE d.project_id = $1 ORDER BY d.uploaded_at DESC, d.file_name`,
          [projectId],
        )
        return rows.map(toSummary)
      })
    },

    find(viewerId, projectId, documentId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<DocumentRow>(
          `${SUMMARY} WHERE d.id = $1 AND d.project_id = $2`,
          [documentId, projectId],
        )
        return rows[0] ? toSummary(rows[0]) : null
      })
    },

    chunks(viewerId, documentId, limit) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<{ locator: Locator; text: string }>(
          `SELECT locator, text FROM document_chunks
            WHERE document_id = $1 ORDER BY position LIMIT $2`,
          [documentId, limit],
        )
        return rows.map((row) => ({ locator: row.locator, text: row.text }))
      })
    },

    saveClassification(viewerId, documentId, state) {
      return asViewer(pool, viewerId, async (client) => {
        await client.query(
          `UPDATE documents SET kind = $2, audience = $3, audience_source = $4, uncertain = $5
            WHERE id = $1`,
          [documentId, state.kind, state.audience, state.audienceSource, state.uncertain],
        )
        const summary = await summaryById(client, documentId)
        if (!summary) throw new Error('document vanished while being classified')
        return summary
      })
    },

    remove(viewerId, documentId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<{ blob_key: string }>(
          'DELETE FROM documents WHERE id = $1 RETURNING blob_key',
          [documentId],
        )
        return rows[0]?.blob_key ?? null
      })
    },
  }
}

/** The worker's view: processes and purges documents of every project. */
export function createDocumentProcessingStore(pool: pg.Pool): DocumentProcessingStore {
  return {
    async pending(documentId) {
      const { rows } = await pool.query<{
        id: string
        file_name: string
        media_type: string
        blob_key: string
        uploaded_at: Date
      }>(
        `SELECT id, file_name, media_type, blob_key, uploaded_at FROM documents
          WHERE id = $1 AND status = 'pending'`,
        [documentId],
      )
      const row = rows[0]
      if (!row) return null
      const document: DocumentToProcess = {
        id: row.id,
        fileName: row.file_name,
        mediaType: row.media_type,
        blobKey: row.blob_key,
        uploadedAt: row.uploaded_at,
      }
      return document
    },

    async markReady(documentId, extraction, classification) {
      await inTransaction(pool, async (client) => {
        // A retried job starts from a clean slate.
        await client.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId])
        await client.query(
          `INSERT INTO document_chunks (document_id, project_id, position, locator, text)
           SELECT d.id, d.project_id, c.position - 1, c.locator, c.text
             FROM documents d,
                  unnest($2::jsonb[], $3::text[]) WITH ORDINALITY AS c(locator, text, position)
            WHERE d.id = $1`,
          [
            documentId,
            extraction.chunks.map((chunk) => JSON.stringify(chunk.locator)),
            extraction.chunks.map((chunk) => chunk.text),
          ],
        )
        await client.query(
          `UPDATE documents
              SET status = 'ready', kind = $2, audience = $3, audience_source = $4,
                  document_date = $5, date_source = $6, uncertain = $7, warnings = $8,
                  extractor = $9, chunk_count = $10, processed_at = now()
            WHERE id = $1`,
          [
            documentId,
            classification.kind,
            classification.audience,
            classification.audienceSource,
            classification.dateOf.date,
            classification.dateOf.source,
            classification.uncertain,
            extraction.warnings,
            extraction.extractor,
            extraction.chunks.length,
          ],
        )
      })
    },

    async markFailed(documentId, extraction) {
      await pool.query(
        `UPDATE documents SET status = 'failed', warnings = $2, extractor = $3, processed_at = now()
          WHERE id = $1`,
        [documentId, extraction.warnings, extraction.extractor],
      )
    },

    async expired(cutoff, limit) {
      const { rows } = await pool.query<{ id: string; blob_key: string }>(
        `SELECT id, blob_key FROM documents WHERE uploaded_at < $1 ORDER BY uploaded_at LIMIT $2`,
        [cutoff, limit],
      )
      return rows.map((row) => ({ id: row.id, blobKey: row.blob_key }))
    },

    async removeExpired(documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    },
  }
}
