import type {
  ExternalItemStore,
  SealedSecret,
  SourceRepository,
  SourceSyncStore,
  SourceTarget,
  SourceToSync,
} from '@octobrief/application'
import type { Source, SourceFeed, SourceKind } from '@octobrief/domain'
import type pg from 'pg'
import { asViewer, inTransaction } from './transaction.ts'

interface SourceRow {
  id: string
  project_id: string
  kind: SourceKind
  feed: SourceFeed
  folder_path: string | null
  name: string
  config: Record<string, unknown>
  perimeter: string[]
  last_sync_at: Date | null
  data_as_of: Date | null
  last_error: string | null
  document_count: number
  created_by: string
  created_at: Date
}

const SOURCE = `
  SELECT s.id, s.project_id, s.kind, s.folder_path,
         CASE WHEN s.folder_path IS NOT NULL THEN 'folder'
              WHEN s.token_hash IS NOT NULL THEN 'push'
              ELSE 'direct' END AS feed,
         s.name, s.config, s.perimeter, s.last_sync_at,
         s.data_as_of, s.last_error, s.created_by, s.created_at,
         (SELECT count(*) FROM documents d WHERE d.source_id = s.id)::int AS document_count
    FROM sources s`

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    feed: row.feed,
    folderPath: row.folder_path,
    name: row.name,
    config: row.config,
    perimeter: row.perimeter,
    lastSyncAt: row.last_sync_at,
    dataAsOf: row.data_as_of,
    lastError: row.last_error,
    documentCount: row.document_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/** The web's view: every query but the token lookup runs as the signed-in person. */
export function createSourceRepository(pool: pg.Pool): SourceRepository {
  return {
    list(viewerId, projectId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<SourceRow>(
          `${SOURCE} WHERE s.project_id = $1 ORDER BY s.created_at, s.name`,
          [projectId],
        )
        return rows.map(toSource)
      })
    },

    find(viewerId, projectId, sourceId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<SourceRow>(
          `${SOURCE} WHERE s.id = $1 AND s.project_id = $2`,
          [sourceId, projectId],
        )
        return rows[0] ? toSource(rows[0]) : null
      })
    },

    create(viewerId, source) {
      return asViewer(pool, viewerId, async (client) => {
        const { secret } = source
        const inserted = await client.query(
          `INSERT INTO sources (id, project_id, kind, name, config, perimeter, token_hash,
                                secret_key_version, secret_iv, secret_tag, secret_ciphertext,
                                created_by, folder_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (project_id, name) DO NOTHING`,
          [
            source.id,
            source.projectId,
            source.kind,
            source.name,
            JSON.stringify(source.config),
            source.perimeter,
            source.tokenHash,
            secret?.keyVersion ?? null,
            secret ? Buffer.from(secret.iv) : null,
            secret ? Buffer.from(secret.tag) : null,
            secret ? Buffer.from(secret.ciphertext) : null,
            source.createdBy,
            source.folderPath,
          ],
        )
        if (inserted.rowCount === 0) return null
        const { rows } = await client.query<SourceRow>(`${SOURCE} WHERE s.id = $1`, [source.id])
        return rows[0] ? toSource(rows[0]) : null
      })
    },

    async remove(viewerId, sourceId) {
      await asViewer(pool, viewerId, (client) =>
        client.query('DELETE FROM sources WHERE id = $1', [sourceId]),
      )
    },

    async setTokenHash(viewerId, sourceId, tokenHash) {
      await asViewer(pool, viewerId, (client) =>
        client.query('UPDATE sources SET token_hash = $2 WHERE id = $1', [sourceId, tokenHash]),
      )
    },

    async ingestTarget(sourceId, tokenHash) {
      const { rows } = await pool.query<{
        id: string
        project_id: string
        kind: SourceKind
        created_by: string
      }>('SELECT id, project_id, kind, created_by FROM app_ingest_target($1, $2)', [
        sourceId,
        tokenHash,
      ])
      const row = rows[0]
      return row
        ? { id: row.id, projectId: row.project_id, kind: row.kind, createdBy: row.created_by }
        : null
    },
  }
}

interface SyncRow {
  id: string
  project_id: string
  kind: SourceKind
  created_by: string
  folder_path: string | null
  config: Record<string, unknown>
  perimeter: string[]
  cursor: unknown
  secret_key_version: number | null
  secret_iv: Buffer | null
  secret_tag: Buffer | null
  secret_ciphertext: Buffer | null
}

function sealedOf(row: SyncRow): SealedSecret | null {
  if (row.secret_key_version === null || !row.secret_iv || !row.secret_tag) return null
  if (!row.secret_ciphertext) return null
  return {
    keyVersion: row.secret_key_version,
    iv: row.secret_iv,
    tag: row.secret_tag,
    ciphertext: row.secret_ciphertext,
  }
}

/** What the worker reads by itself: a folder, or a system it holds the credential of. */
const READ_BY_WORKER = '(folder_path IS NOT NULL OR token_hash IS NULL)'

/** The worker's view of the sources it reads by itself. */
export function createSourceSyncStore(pool: pg.Pool): SourceSyncStore {
  return {
    async pullSourceIds() {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM sources WHERE ${READ_BY_WORKER} ORDER BY created_at`,
      )
      return rows.map((row) => row.id)
    },

    async load(sourceId) {
      const { rows } = await pool.query<SyncRow>(
        `SELECT id, project_id, kind, created_by, folder_path, config, perimeter, cursor,
                secret_key_version, secret_iv, secret_tag, secret_ciphertext
           FROM sources WHERE id = $1 AND ${READ_BY_WORKER}`,
        [sourceId],
      )
      const row = rows[0]
      if (!row) return null
      const source: SourceToSync = {
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        createdBy: row.created_by,
        folderPath: row.folder_path,
        config: row.config,
        perimeter: row.perimeter,
        cursor: row.cursor,
        secret: sealedOf(row),
      }
      return source
    },

    async saveCursor(sourceId, cursor) {
      await pool.query('UPDATE sources SET cursor = $2 WHERE id = $1', [
        sourceId,
        JSON.stringify(cursor ?? null),
      ])
    },
  }
}

type Run = <T>(target: SourceTarget, work: (client: pg.PoolClient) => Promise<T>) => Promise<T>

/**
 * Where the items of a source are stored. `asCreator` (the web, for a feeder's delivery) runs
 * every statement as the person who connected the source, under row-level security; without it
 * (the worker) statements run as the worker.
 */
export function createExternalItemStore(
  pool: pg.Pool,
  mode: { asCreator: boolean },
): ExternalItemStore {
  const run: Run = (target, work) =>
    mode.asCreator ? asViewer(pool, target.createdBy, work) : inTransaction(pool, work)
  return {
    document(target, externalId) {
      return run(target, async (client) => {
        const { rows } = await client.query<{
          id: string
          external_version: string
          blob_key: string
        }>(
          `SELECT id, external_version, blob_key FROM documents
            WHERE source_id = $1 AND external_id = $2`,
          [target.id, externalId],
        )
        const row = rows[0]
        return row
          ? { documentId: row.id, version: row.external_version, blobKey: row.blob_key }
          : null
      })
    },

    createDocument(target, { item, fileName, sha256, blobKey }) {
      return run(target, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO documents
             (project_id, file_name, media_type, size_bytes, sha256, blob_key, uploaded_by,
              source_id, external_id, external_version, origin_at, external_url, system_kind,
              file_modified_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (project_id, sha256) DO NOTHING
           RETURNING id`,
          [
            target.projectId,
            fileName,
            item.mediaType,
            item.bytes.length,
            sha256,
            blobKey,
            target.createdBy,
            target.id,
            item.externalId,
            item.version,
            item.originAt,
            item.url,
            item.systemKind ?? null,
            item.fileModifiedAt ?? null,
          ],
        )
        return rows[0]?.id ?? null
      })
    },

    removeDocument(target, documentId) {
      return run(target, async (client) => {
        const { rows } = await client.query<{ blob_key: string }>(
          'DELETE FROM documents WHERE id = $1 AND source_id = $2 RETURNING blob_key',
          [documentId, target.id],
        )
        return rows[0]?.blob_key ?? null
      })
    },

    async saveRecords(target, records) {
      await run(target, (client) =>
        client.query(
          `INSERT INTO tracker_items
             (source_id, external_id, project_id, version, title, record, origin_at, external_url)
           SELECT $1, r.external_id, $2, r.version, r.title, r.record, r.origin_at, r.url
             FROM unnest($3::text[], $4::text[], $5::text[], $6::jsonb[], $7::timestamptz[],
                         $8::text[]) AS r(external_id, version, title, record, origin_at, url)
           ON CONFLICT (source_id, external_id) DO UPDATE
             SET version = excluded.version, title = excluded.title, record = excluded.record,
                 origin_at = excluded.origin_at, external_url = excluded.external_url,
                 removed_at = NULL`,
          [
            target.id,
            target.projectId,
            records.map((r) => r.externalId),
            records.map((r) => r.version),
            records.map((r) => r.title),
            records.map((r) => JSON.stringify(r.record)),
            records.map((r) => r.originAt),
            records.map((r) => r.url),
          ],
        ),
      )
    },

    async markRemoved(target, externalIds) {
      await run(target, (client) =>
        client.query(
          `UPDATE tracker_items SET removed_at = now()
            WHERE source_id = $1 AND external_id = ANY($2::text[]) AND removed_at IS NULL`,
          [target.id, externalIds],
        ),
      )
    },

    async saveRows(target, view) {
      await run(target, (client) =>
        client.query(
          `INSERT INTO system_rows
             (source_id, view, perimeter, key, project_id, "values", extracted_at,
              source_synced_at)
           SELECT $1, $2, $3, r.key, $4, r.vals, $5, $6
             FROM unnest($7::text[], $8::jsonb[]) AS r(key, vals)
           ON CONFLICT (source_id, view, perimeter, key) DO UPDATE
             SET "values" = excluded."values", extracted_at = excluded.extracted_at,
                 source_synced_at = excluded.source_synced_at`,
          [
            target.id,
            view.view,
            view.perimeter,
            target.projectId,
            view.extractedAt,
            view.sourceSyncedAt,
            view.rows.map((row) => row.key),
            view.rows.map((row) => JSON.stringify(row.values)),
          ],
        ),
      )
    },

    async savePeople(target, people) {
      const names = people.map((p) => p.displayName)
      const emails = people.map((p) => p.email ?? '')
      await run(target, async (client) => {
        // A name first read in a document (no email) becomes this person, not a second one.
        await client.query(
          `UPDATE project_people pp
              SET email = p.email
             FROM (SELECT DISTINCT ON (lower(display_name)) display_name, email
                     FROM unnest($2::text[], $3::text[]) AS p(display_name, email)
                    WHERE email <> ''
                    ORDER BY lower(display_name), email) p
            WHERE pp.project_id = $1 AND pp.email = ''
              AND lower(pp.display_name) = lower(p.display_name)
              AND NOT EXISTS (
                SELECT 1 FROM project_people known
                 WHERE known.project_id = $1 AND known.email <> ''
                   AND lower(known.display_name) = lower(p.display_name))`,
          [target.projectId, names, emails],
        )
        await client.query(
          `INSERT INTO project_people (project_id, display_name, email, untrusted)
           SELECT DISTINCT ON (p.display_name, p.email) $1, p.display_name, p.email, p.untrusted
             FROM unnest($2::text[], $3::text[], $4::boolean[])
                    AS p(display_name, email, untrusted)
            ORDER BY p.display_name, p.email, p.untrusted
           ON CONFLICT (project_id, display_name, email) DO UPDATE
             SET untrusted = project_people.untrusted AND excluded.untrusted`,
          [target.projectId, names, emails, people.map((p) => p.untrusted === true)],
        )
      })
    },

    async delivered(target, dataAsOf, error) {
      await run(target, (client) =>
        client.query(
          `UPDATE sources
              SET last_sync_at = now(), last_error = $3,
                  data_as_of = coalesce($2::timestamptz, data_as_of)
            WHERE id = $1`,
          [target.id, dataAsOf, error],
        ),
      )
    },
  }
}
