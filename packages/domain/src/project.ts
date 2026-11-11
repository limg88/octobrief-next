export const PROJECT_NAME_MAX_LENGTH = 120
export const CLIENT_NAME_MAX_LENGTH = 120
const SLUG_MAX_LENGTH = 60
const FALLBACK_SLUG = 'project'

export const MEMBER_ROLES = ['owner', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export interface Project {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly client: string | null
  readonly createdAt: Date
}

export interface ProjectMember {
  readonly userId: string
  readonly displayName: string
  readonly email: string | null
  readonly role: MemberRole
}

export class InvalidProjectError extends Error {
  readonly field: 'name' | 'client'
  constructor(field: 'name' | 'client', message: string) {
    super(message)
    this.name = 'InvalidProjectError'
    this.field = field
  }
}

/** Trims and validates a project's name and client; throws InvalidProjectError otherwise. */
export function normalizeProjectInput(input: {
  name: string
  client?: string | null | undefined
}): {
  name: string
  client: string | null
} {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name === '') throw new InvalidProjectError('name', 'project name is required')
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new InvalidProjectError('name', `project name exceeds ${PROJECT_NAME_MAX_LENGTH} chars`)
  }
  const client = input.client?.trim().replace(/\s+/g, ' ') || null
  if (client !== null && client.length > CLIENT_NAME_MAX_LENGTH) {
    throw new InvalidProjectError('client', `client name exceeds ${CLIENT_NAME_MAX_LENGTH} chars`)
  }
  return { name, client }
}

/** URL-safe identifier from a name: lower case ASCII, words joined by dashes. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
  return slug === '' ? FALLBACK_SLUG : slug
}

/** The first slug not taken: `base`, then `base-2`, `base-3`… */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** Owners manage members; admins manage every project. */
export function canManageMembers(memberRole: MemberRole | null, isAdminUser: boolean): boolean {
  return isAdminUser || memberRole === 'owner'
}
