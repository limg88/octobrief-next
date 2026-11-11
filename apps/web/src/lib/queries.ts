'use client'
import type { Locale } from '@octobrief/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession } from '@/components/shell/session-context'
import { apiRequest } from './api-client'
import type { MemberDto, ProjectDto } from './api-types'

const PROJECTS_KEY = ['projects'] as const
const projectKey = (slug: string) => ['projects', slug] as const
const membersKey = (slug: string) => ['projects', slug, 'members'] as const

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => apiRequest<{ projects: ProjectDto[] }>('/projects').then((r) => r.projects),
  })
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: projectKey(slug),
    queryFn: () => apiRequest<ProjectDto>(`/projects/${encodeURIComponent(slug)}`),
  })
}

export function useMembers(slug: string) {
  return useQuery({
    queryKey: membersKey(slug),
    queryFn: () =>
      apiRequest<{ members: MemberDto[] }>(`/projects/${encodeURIComponent(slug)}/members`).then(
        (r) => r.members,
      ),
  })
}

export function useCreateProject() {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; client: string | null }) =>
      apiRequest<ProjectDto>('/projects', { method: 'POST', body: input, csrfToken }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export function useAddMember(slug: string) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (email: string) =>
      apiRequest<{ members: MemberDto[] }>(`/projects/${encodeURIComponent(slug)}/members`, {
        method: 'POST',
        body: { email },
        csrfToken,
      }),
    onSuccess: (data) => queryClient.setQueryData(membersKey(slug), data.members),
  })
}

export function useChangeLocale() {
  const { csrfToken } = useSession()
  return useMutation({
    mutationFn: (locale: Locale) =>
      apiRequest<void>('/me', { method: 'PATCH', body: { locale }, csrfToken }),
  })
}

export async function signOut(): Promise<void> {
  const { redirectTo } = await apiRequest<{ redirectTo: string }>('/auth/logout', {
    method: 'POST',
  })
  window.location.assign(redirectTo)
}
