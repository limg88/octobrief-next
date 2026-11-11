import type { MemberRole, Project, ProjectMember } from '@octobrief/domain'

export interface ProjectWithRole extends Project {
  /** The viewer's role; null when the viewer sees it as an admin, not as a member. */
  readonly memberRole: MemberRole | null
}

export interface ProjectRepository {
  /** Projects the user is a member of, or every project when `all` is true. */
  listVisible(userId: string, all: boolean): Promise<ProjectWithRole[]>
  findBySlug(slug: string, viewerId: string): Promise<ProjectWithRole | null>
  slugsStartingWith(prefix: string): Promise<Set<string>>
  /** Creates the project with its owner; throws on a duplicate slug. */
  create(input: {
    slug: string
    name: string
    client: string | null
    ownerId: string
  }): Promise<Project>
  listMembers(projectId: string): Promise<ProjectMember[]>
  /** False when the user already is a member. */
  addMember(projectId: string, userId: string, role: MemberRole): Promise<boolean>
}
