import type { ProjectRepository, ProjectWithRole } from '@octobrief/application'
import type { MemberRole, Project, ProjectMember } from '@octobrief/domain'
import type pg from 'pg'
import { inTransaction } from './transaction.ts'

interface ProjectRow {
  id: string
  slug: string
  name: string
  client: string | null
  created_at: Date
}

const PROJECT_COLUMNS = 'p.id, p.slug, p.name, p.client, p.created_at'

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    client: row.client,
    createdAt: row.created_at,
  }
}

function toProjectWithRole(row: ProjectRow & { member_role: MemberRole | null }): ProjectWithRole {
  return { ...toProject(row), memberRole: row.member_role }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function createProjectRepository(pool: pg.Pool): ProjectRepository {
  return {
    async listVisible(userId: string, all: boolean) {
      const { rows } = await pool.query<ProjectRow & { member_role: MemberRole | null }>(
        `SELECT ${PROJECT_COLUMNS}, m.role AS member_role
           FROM projects p
           LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
          WHERE $2 OR m.user_id IS NOT NULL
          ORDER BY p.name`,
        [userId, all],
      )
      return rows.map(toProjectWithRole)
    },

    async findBySlug(slug: string, viewerId: string) {
      const { rows } = await pool.query<ProjectRow & { member_role: MemberRole | null }>(
        `SELECT ${PROJECT_COLUMNS}, m.role AS member_role
           FROM projects p
           LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
          WHERE p.slug = $1`,
        [slug, viewerId],
      )
      return rows[0] ? toProjectWithRole(rows[0]) : null
    },

    async slugsStartingWith(prefix: string) {
      const { rows } = await pool.query<{ slug: string }>(
        `SELECT slug FROM projects WHERE slug LIKE $1 || '%'`,
        [escapeLike(prefix)],
      )
      return new Set(rows.map((row) => row.slug))
    },

    create(input) {
      return inTransaction(pool, async (client) => {
        const { rows } = await client.query<ProjectRow>(
          `INSERT INTO projects AS p (slug, name, client, created_by) VALUES ($1, $2, $3, $4)
           RETURNING ${PROJECT_COLUMNS}`,
          [input.slug, input.name, input.client, input.ownerId],
        )
        const project = toProject(rows[0] as ProjectRow)
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [project.id, input.ownerId],
        )
        return project
      })
    },

    async listMembers(projectId: string) {
      const { rows } = await pool.query<{
        user_id: string
        display_name: string
        email: string | null
        role: MemberRole
      }>(
        `SELECT m.user_id, u.display_name, u.email, m.role
           FROM project_members m JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1
          ORDER BY m.role DESC, u.display_name`,
        [projectId],
      )
      return rows.map(
        (row): ProjectMember => ({
          userId: row.user_id,
          displayName: row.display_name,
          email: row.email,
          role: row.role,
        }),
      )
    },

    async addMember(projectId: string, userId: string, role: MemberRole) {
      const { rowCount } = await pool.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [projectId, userId, role],
      )
      return rowCount === 1
    },
  }
}
