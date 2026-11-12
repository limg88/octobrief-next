import type {
  Question,
  QuestionRepository,
  QuestionToAnswer,
  QuestionWorkStore,
} from '@octobrief/application'
import { type Lang, type QuestionPhase, rehydrateVerifiedAnswer } from '@octobrief/domain'
import type pg from 'pg'
import { asViewer } from './transaction.ts'

interface QuestionRow {
  id: string
  project_id: string
  asked_by: string
  text: string
  lang: Lang
  phase: QuestionPhase
  answer: unknown
  error: string | null
  asked_at: Date
  answered_at: Date | null
}

const COLUMNS = 'id, project_id, asked_by, text, lang, phase, answer, error, asked_at, answered_at'

function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    projectId: row.project_id,
    askedBy: row.asked_by,
    text: row.text,
    lang: row.lang,
    phase: row.phase,
    // Read back through the domain: a stored value never shows what the checks suspended.
    answer: row.answer === null ? null : rehydrateVerifiedAnswer(row.answer),
    error: row.error,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  }
}

/** The web's view: a person sees only their own questions, under row-level security. */
export function createQuestionRepository(pool: pg.Pool): QuestionRepository {
  return {
    create(viewerId, question) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<QuestionRow>(
          `INSERT INTO questions (project_id, asked_by, text, lang)
           VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
          [question.projectId, viewerId, question.text, question.lang],
        )
        return toQuestion(rows[0] as QuestionRow)
      })
    },

    list(viewerId, projectId, limit) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<QuestionRow>(
          `SELECT ${COLUMNS} FROM questions
            WHERE project_id = $1 ORDER BY asked_at DESC, id LIMIT $2`,
          [projectId, limit],
        )
        return rows.map(toQuestion)
      })
    },

    find(viewerId, projectId, questionId) {
      return asViewer(pool, viewerId, async (client) => {
        const { rows } = await client.query<QuestionRow>(
          `SELECT ${COLUMNS} FROM questions WHERE id = $1 AND project_id = $2`,
          [questionId, projectId],
        )
        return rows[0] ? toQuestion(rows[0]) : null
      })
    },

    async remove(viewerId, questionId) {
      await asViewer(pool, viewerId, (client) =>
        client.query('DELETE FROM questions WHERE id = $1', [questionId]),
      )
    },
  }
}

/** The worker's view: answers the questions of every project. */
export function createQuestionWorkStore(pool: pg.Pool): QuestionWorkStore {
  return {
    async pending(questionId) {
      const { rows } = await pool.query<QuestionRow>(
        `SELECT ${COLUMNS} FROM questions
          WHERE id = $1 AND phase IN ('queued', 'reading', 'checking')`,
        [questionId],
      )
      const row = rows[0]
      if (!row) return null
      const question: QuestionToAnswer = {
        id: row.id,
        projectId: row.project_id,
        askedBy: row.asked_by,
        text: row.text,
        lang: row.lang,
      }
      return question
    },

    async setPhase(questionId, phase) {
      await pool.query('UPDATE questions SET phase = $2 WHERE id = $1', [questionId, phase])
    },

    async saveAnswer(questionId, answer, run) {
      await pool.query(
        `UPDATE questions
            SET phase = 'done', answer = $2, error = NULL, turns = $3, backend = $4,
                answered_at = now()
          WHERE id = $1`,
        [questionId, JSON.stringify(answer), run.turns, run.backend],
      )
    },

    async saveFailure(questionId, code) {
      await pool.query(
        `UPDATE questions SET phase = 'failed', error = $2, answered_at = now() WHERE id = $1`,
        [questionId, code],
      )
    },
  }
}
