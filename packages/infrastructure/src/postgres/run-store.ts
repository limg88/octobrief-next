import type {
  DeliverableFile,
  RunDetails,
  RunRecord,
  RunRepository,
  RunRevision,
  RunWorkStore,
} from '@octobrief/application'
import type {
  Acceptance,
  FileAudience,
  ParameterValues,
  PmDecision,
  RedTeamRow,
  RenderFormat,
  RevisionOrigin,
  RunGateContext,
  RunPhase,
  RunStatus,
} from '@octobrief/domain/recipe'
import type pg from 'pg'
import { asViewer, inTransaction } from './transaction.ts'

interface RunRow {
  id: string
  project_id: string
  requested_by: string
  recipe_slug: string
  recipe_version: string
  recipe_hash: string
  parameters: ParameterValues
  status: RunStatus
  phase: RunPhase | null
  error_code: string | null
  revision_error: string | null
  gate: RunGateContext | null
  acceptances: Acceptance[]
  decisions: PmDecision[]
  approval_status: RunRecord['approval']
  approval_error: string | null
  approved_at: Date | null
  created_at: Date
}

const RUN = `
  SELECT id, project_id, requested_by, recipe_slug, recipe_version, recipe_hash, parameters,
         status, phase, error_code, revision_error, gate, acceptances, decisions,
         approval_status, approval_error, approved_at, created_at
    FROM recipe_runs`

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    requestedBy: row.requested_by,
    recipeSlug: row.recipe_slug,
    recipeVersion: row.recipe_version,
    recipeHash: row.recipe_hash,
    parameters: row.parameters,
    status: row.status,
    phase: row.phase,
    errorCode: row.error_code,
    revisionError: row.revision_error,
    gate: row.gate,
    acceptances: row.acceptances,
    decisions: row.decisions,
    approval: row.approval_status,
    approvalError: row.approval_error,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  }
}

type Db = Pick<pg.PoolClient, 'query'>

async function detailsOf(db: Db, run: RunRecord): Promise<RunDetails> {
  const revisions = await db.query<{
    seq: number
    origin: RevisionOrigin
    document: unknown
    red_team: RedTeamRow[]
    verifications: unknown
    skeleton_hash: string
    data_hash: string
    created_at: Date
  }>(
    `SELECT seq, origin, document, red_team, verifications, skeleton_hash, data_hash, created_at
       FROM run_revisions WHERE run_id = $1 ORDER BY seq DESC LIMIT 1`,
    [run.id],
  )
  const last = revisions.rows[0]
  const revision: RunRevision | null = last
    ? {
        seq: last.seq,
        origin: last.origin,
        document: last.document,
        rows: last.red_team,
        verifications: last.verifications,
        skeletonHash: last.skeleton_hash,
        dataHash: last.data_hash,
        createdAt: last.created_at,
      }
    : null
  const files = await db.query<{
    id: string
    audience: FileAudience
    format: RenderFormat
    file_name: string
    sha256: string
    size_bytes: string
    blob_key: string
  }>(
    `SELECT id, audience, format, file_name, sha256, size_bytes, blob_key
       FROM deliverable_files WHERE run_id = $1 ORDER BY audience DESC, format`,
    [run.id],
  )
  return {
    run,
    revision,
    files: files.rows.map(
      (row): DeliverableFile => ({
        id: row.id,
        audience: row.audience,
        format: row.format,
        fileName: row.file_name,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        blobKey: row.blob_key,
      }),
    ),
  }
}

/** The web's view: every query runs as the signed-in person, under row-level security. */
export function createRunRepository(pool: pg.Pool): RunRepository {
  return {
    create(viewerId, run) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO recipe_runs
             (project_id, requested_by, recipe_slug, recipe_version, recipe_hash, parameters)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            run.projectId,
            viewerId,
            run.recipeSlug,
            run.recipeVersion,
            run.recipeHash,
            JSON.stringify(run.parameters),
          ],
        )
        const created = await client.query<RunRow>(`${RUN} WHERE id = $1`, [rows[0]?.id])
        return toRun(created.rows[0] as RunRow)
      })
    },

    list(viewerId, projectId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<RunRow>(
          `${RUN} WHERE project_id = $1 AND status <> 'discarded' ORDER BY created_at DESC, id`,
          [projectId],
        )
        return rows.map(toRun)
      })
    },

    find(viewerId, projectId, runId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<RunRow>(`${RUN} WHERE id = $1 AND project_id = $2`, [
          runId,
          projectId,
        ])
        return rows[0] ? detailsOf(client, toRun(rows[0])) : null
      })
    },

    async saveJudgements(viewerId, runId, judgements) {
      await asViewer(pool, viewerId, (client) =>
        client.query(
          `UPDATE recipe_runs SET acceptances = $2, decisions = $3, updated_at = now()
            WHERE id = $1`,
          [runId, JSON.stringify(judgements.acceptances), JSON.stringify(judgements.decisions)],
        ),
      )
    },

    requestApproval(viewerId, runId) {
      return asViewer(pool, viewerId, async (client) => {
        const moved = await client.query(
          `UPDATE recipe_runs
              SET approval_status = 'approving', approval_error = NULL, approved_by = $2,
                  updated_at = now()
            WHERE id = $1 AND status = 'ready'
              AND (approval_status IS NULL OR approval_status = 'render_failed')`,
          [runId, viewerId],
        )
        return moved.rowCount === 1
      })
    },

    async discard(viewerId, runId) {
      await asViewer(pool, viewerId, (client) =>
        client.query(
          `UPDATE recipe_runs SET status = 'discarded', updated_at = now()
            WHERE id = $1 AND status IN ('ready', 'failed') AND approval_status IS NULL`,
          [runId],
        ),
      )
    },
  }
}

/** The worker's view: runs of every project. */
export function createRunWorkStore(pool: pg.Pool): RunWorkStore {
  return {
    async load(runId) {
      const { rows } = await pool.query<RunRow>(`${RUN} WHERE id = $1`, [runId])
      return rows[0] ? detailsOf(pool, toRun(rows[0])) : null
    },

    async move(runId, from, change) {
      const sets = ['updated_at = now()']
      const values: unknown[] = [runId, from]
      const set = (column: string, value: unknown) => {
        values.push(value)
        sets.push(`${column} = $${values.length}`)
      }
      if (change.status !== undefined) set('status', change.status)
      if (change.phase !== undefined) set('phase', change.phase)
      if (change.errorCode !== undefined) set('error_code', change.errorCode)
      if (change.revisionError !== undefined) set('revision_error', change.revisionError)
      if (change.usage !== undefined) set('usage', JSON.stringify(change.usage))
      const moved = await pool.query(
        `UPDATE recipe_runs SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($2::text[])`,
        values,
      )
      return moved.rowCount === 1
    },

    async saveSnapshot(runId, snapshot, gate) {
      await pool.query(
        'UPDATE recipe_runs SET snapshot = $2, gate = $3, updated_at = now() WHERE id = $1',
        [runId, JSON.stringify(snapshot), JSON.stringify(gate)],
      )
    },

    async saveRevision(runId, revision) {
      await pool.query(
        `INSERT INTO run_revisions
           (run_id, seq, project_id, origin, document, red_team, verifications, skeleton_hash,
            data_hash)
         SELECT r.id, coalesce((SELECT max(seq) FROM run_revisions WHERE run_id = r.id), 0) + 1,
                r.project_id, $2, $3, $4, $5, $6, $7
           FROM recipe_runs r WHERE r.id = $1`,
        [
          runId,
          revision.origin,
          JSON.stringify(revision.document),
          JSON.stringify(revision.rows),
          JSON.stringify(revision.verifications),
          revision.skeletonHash,
          revision.dataHash,
        ],
      )
    },

    async completeApproval(runId, files) {
      await inTransaction(pool, async (client) => {
        // An approval asked again after a failed render starts from no files.
        await client.query('DELETE FROM deliverable_files WHERE run_id = $1', [runId])
        for (const file of files) {
          await client.query(
            `INSERT INTO deliverable_files
               (run_id, project_id, audience, format, file_name, sha256, size_bytes, blob_key)
             SELECT r.id, r.project_id, $2, $3, $4, $5, $6, $7 FROM recipe_runs r WHERE r.id = $1`,
            [
              runId,
              file.audience,
              file.format,
              file.fileName,
              file.sha256,
              file.sizeBytes,
              file.blobKey,
            ],
          )
        }
        await client.query(
          `UPDATE recipe_runs
              SET approval_status = 'approved', approval_error = NULL, approved_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [runId],
        )
      })
    },

    async failApproval(runId, code) {
      await pool.query(
        `UPDATE recipe_runs
            SET approval_status = 'render_failed', approval_error = $2, updated_at = now()
          WHERE id = $1`,
        [runId, code],
      )
    },
  }
}
