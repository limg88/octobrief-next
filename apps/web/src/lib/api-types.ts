import type { Locale, MemberRole, UserRole } from '@octobrief/domain'

// Shapes of the JSON responses, as documented in /api/openapi.json.

export interface SessionUser {
  id: string
  displayName: string
  email: string | null
  role: UserRole
  locale: Locale
}

export interface ProjectDto {
  id: string
  slug: string
  name: string
  client: string | null
  createdAt: string
  memberRole: MemberRole | null
}

export interface MemberDto {
  userId: string
  displayName: string
  email: string | null
  role: MemberRole
}
