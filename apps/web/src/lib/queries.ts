'use client'
import type { Audience, DocumentKind, Locale } from '@octobrief/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSession } from '@/components/shell/session-context'
import { apiRequest } from './api-client'
import type { DocumentDto, DocumentTextDto, MemberDto, ProjectDto } from './api-types'

const PROJECTS_KEY = ['projects'] as const
const projectKey = (slug: string) => ['projects', slug] as const
const membersKey = (slug: string) => ['projects', slug, 'members'] as const
const documentsKey = (slug: string) => ['projects', slug, 'documents'] as const
const documentsPath = (slug: string) => `/projects/${encodeURIComponent(slug)}/documents`
/** How often the list refreshes while a document is still being processed. */
export const PENDING_POLL_MS = 2_000

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

export function useDocuments(slug: string) {
  return useQuery({
    queryKey: documentsKey(slug),
    queryFn: () =>
      apiRequest<{ documents: DocumentDto[] }>(documentsPath(slug)).then((r) => r.documents),
    refetchInterval: (query) =>
      query.state.data?.some((document) => document.status === 'pending') ? PENDING_POLL_MS : false,
  })
}

export function useDocumentText(slug: string, documentId: string | null) {
  return useQuery({
    queryKey: [...documentsKey(slug), documentId],
    queryFn: () => apiRequest<DocumentTextDto>(`${documentsPath(slug)}/${documentId}`),
    enabled: documentId !== null,
  })
}

function useDocumentMutation<I, O>(
  slug: string,
  call: (input: I, csrfToken: string) => Promise<O>,
) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: I) => call(input, csrfToken),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey(slug) }),
  })
}

export function useUploadDocument(slug: string) {
  return useDocumentMutation(slug, (file: File, csrfToken) => {
    const body = new FormData()
    body.append('file', file)
    return apiRequest<DocumentDto>(documentsPath(slug), { method: 'POST', body, csrfToken })
  })
}

export function useReclassifyDocument(slug: string) {
  return useDocumentMutation(
    slug,
    (input: { id: string; kind?: DocumentKind; audience?: Audience }, csrfToken) => {
      const { id, ...change } = input
      return apiRequest<DocumentDto>(`${documentsPath(slug)}/${id}`, {
        method: 'PATCH',
        body: change,
        csrfToken,
      })
    },
  )
}

export function useDeleteDocument(slug: string) {
  return useDocumentMutation(slug, (id: string, csrfToken) =>
    apiRequest<void>(`${documentsPath(slug)}/${id}`, { method: 'DELETE', csrfToken }),
  )
}

export async function signOut(): Promise<void> {
  const { redirectTo } = await apiRequest<{ redirectTo: string }>('/auth/logout', {
    method: 'POST',
  })
  window.location.assign(redirectTo)
}
