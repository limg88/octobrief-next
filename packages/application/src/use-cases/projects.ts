import {
  canManageMembers,
  isAdmin,
  normalizeProjectInput,
  type Project,
  type ProjectMember,
  slugify,
  type User,
  uniqueSlug,
} from '@octobrief/domain'
import { ApplicationError } from '../errors.ts'
import type { UserRepository } from '../ports/auth-stores.ts'
import type { ProjectRepository, ProjectWithRole } from '../ports/project-repository.ts'

export interface ProjectDependencies {
  readonly projects: ProjectRepository
  readonly users: UserRepository
}

export function listProjects(deps: ProjectDependencies, viewer: User): Promise<ProjectWithRole[]> {
  return deps.projects.listVisible(viewer.id, isAdmin(viewer))
}

export async function createProject(
  deps: ProjectDependencies,
  viewer: User,
  input: { name: string; client?: string | null | undefined },
): Promise<Project> {
  const { name, client } = normalizeProjectInput(input)
  const base = slugify(name)
  const slug = uniqueSlug(base, await deps.projects.slugsStartingWith(base))
  return deps.projects.create({ slug, name, client, ownerId: viewer.id })
}

/** The project as the viewer may see it; not_found also hides projects the viewer cannot see. */
export async function getProject(
  deps: ProjectDependencies,
  viewer: User,
  slug: string,
): Promise<ProjectWithRole> {
  const project = await deps.projects.findBySlug(slug, viewer.id)
  if (!project || (project.memberRole === null && !isAdmin(viewer))) {
    throw new ApplicationError('not_found', 'project not found')
  }
  return project
}

export async function listMembers(
  deps: ProjectDependencies,
  viewer: User,
  slug: string,
): Promise<ProjectMember[]> {
  const project = await getProject(deps, viewer, slug)
  return deps.projects.listMembers(project.id)
}

/** Adds a person who has signed in at least once, found by email. */
export async function addMember(
  deps: ProjectDependencies,
  viewer: User,
  slug: string,
  email: string,
): Promise<ProjectMember[]> {
  const project = await getProject(deps, viewer, slug)
  if (!canManageMembers(project.memberRole, isAdmin(viewer))) {
    throw new ApplicationError('forbidden', 'only owners and admins manage members')
  }
  const user = await deps.users.findByEmail(email.trim().toLowerCase())
  if (!user) throw new ApplicationError('not_found', 'no user with this email has signed in')
  const added = await deps.projects.addMember(project.id, user.id, 'member')
  if (!added) throw new ApplicationError('conflict', 'already a member')
  return deps.projects.listMembers(project.id)
}
