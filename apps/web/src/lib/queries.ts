'use client'
import {
  type Audience,
  type DocumentKind,
  isTerminalPhase,
  type Locale,
  type QuestionPhase,
} from '@octobrief/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSession } from '@/components/shell/session-context'
import { apiRequest } from './api-client'
import type {
  DocumentDto,
  DocumentTextDto,
  KnowledgeDto,
  MemberDto,
  ProjectDto,
  QuestionDto,
  QuestionSummaryDto,
  RecipeDto,
  RunDto,
  RunViewDto,
  SourceDto,
} from './api-types'

const PROJECTS_KEY = ['projects'] as const
const projectKey = (slug: string) => ['projects', slug] as const
const membersKey = (slug: string) => ['projects', slug, 'members'] as const
const documentsKey = (slug: string) => ['projects', slug, 'documents'] as const
const knowledgeKey = (slug: string) => ['projects', slug, 'knowledge'] as const
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

/** The facts of a project; refreshed while a document is still being read. */
export function useKnowledge(slug: string) {
  return useQuery({
    queryKey: knowledgeKey(slug),
    queryFn: () => apiRequest<KnowledgeDto>(`/projects/${encodeURIComponent(slug)}/knowledge`),
    refetchInterval: (query) =>
      (query.state.data?.progress.reading ?? 0) > 0 ? PENDING_POLL_MS : false,
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
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: documentsKey(slug) }),
        queryClient.invalidateQueries({ queryKey: knowledgeKey(slug) }),
      ]),
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

const sourcesKey = (slug: string) => ['projects', slug, 'sources'] as const
const sourcesPath = (slug: string) => `/projects/${encodeURIComponent(slug)}/sources`

export function useSources(slug: string) {
  return useQuery({
    queryKey: sourcesKey(slug),
    queryFn: () => apiRequest<{ sources: SourceDto[] }>(sourcesPath(slug)).then((r) => r.sources),
  })
}

function useSourceMutation<I, O>(slug: string, call: (input: I, csrfToken: string) => Promise<O>) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: I) => call(input, csrfToken),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sourcesKey(slug) }),
  })
}

export interface NewSourceInput {
  kind: string
  name: string
  config?: Record<string, unknown>
  secret?: string
  scope?: string[]
}

export function useCreateSource(slug: string) {
  return useSourceMutation(slug, (input: NewSourceInput, csrfToken) =>
    apiRequest<{ source: SourceDto; ingestToken: string | null }>(sourcesPath(slug), {
      method: 'POST',
      body: input,
      csrfToken,
    }),
  )
}

export function useDeleteSource(slug: string) {
  return useSourceMutation(slug, (id: string, csrfToken) =>
    apiRequest<void>(`${sourcesPath(slug)}/${id}`, { method: 'DELETE', csrfToken }),
  )
}

export function useRotateSourceToken(slug: string) {
  return useSourceMutation(slug, (id: string, csrfToken) =>
    apiRequest<{ ingestToken: string }>(`${sourcesPath(slug)}/${id}/token`, {
      method: 'POST',
      csrfToken,
    }),
  )
}

export function useSyncSource(slug: string) {
  return useSourceMutation(slug, (id: string, csrfToken) =>
    apiRequest<void>(`${sourcesPath(slug)}/${id}/sync`, { method: 'POST', csrfToken }),
  )
}

const questionsKey = (slug: string) => ['projects', slug, 'questions'] as const
const questionsPath = (slug: string) => `/projects/${encodeURIComponent(slug)}/questions`

export function useQuestions(slug: string) {
  return useQuery({
    queryKey: questionsKey(slug),
    queryFn: () =>
      apiRequest<{ questions: QuestionSummaryDto[] }>(questionsPath(slug)).then((r) => r.questions),
  })
}

export function useQuestion(slug: string, id: string) {
  return useQuery({
    queryKey: [...questionsKey(slug), id],
    queryFn: () => apiRequest<QuestionDto>(`${questionsPath(slug)}/${id}`),
  })
}

/**
 * The phase of a question while it is being answered, from the server's event stream; null
 * until the first event. When the question settles, its answer and the history are read again.
 */
export function useQuestionProgress(
  slug: string,
  id: string,
  known: QuestionPhase | undefined,
): QuestionPhase | null {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<QuestionPhase | null>(null)
  const settled = known !== undefined && isTerminalPhase(known)
  useEffect(() => {
    if (known === undefined || settled) return
    const events = new EventSource(`/api${questionsPath(slug)}/${id}/events`)
    events.addEventListener('phase', (event) => {
      const next = (JSON.parse((event as MessageEvent<string>).data) as { phase: QuestionPhase })
        .phase
      setPhase(next)
      if (isTerminalPhase(next)) {
        events.close()
        void queryClient.invalidateQueries({ queryKey: questionsKey(slug) })
      }
    })
    // A dropped stream is not retried forever: the answer is read once more instead.
    events.onerror = () => {
      events.close()
      void queryClient.invalidateQueries({ queryKey: questionsKey(slug) })
    }
    return () => events.close()
  }, [slug, id, known, settled, queryClient])
  return settled ? null : phase
}

export function useAskQuestion(slug: string) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) =>
      apiRequest<QuestionSummaryDto>(questionsPath(slug), {
        method: 'POST',
        body: { text },
        csrfToken,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: questionsKey(slug) }),
  })
}

export function useDeleteQuestion(slug: string) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<void>(`${questionsPath(slug)}/${id}`, { method: 'DELETE', csrfToken }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: questionsKey(slug) }),
  })
}

const runsKey = (slug: string) => ['projects', slug, 'runs'] as const
const runsPath = (slug: string) => `/projects/${encodeURIComponent(slug)}/runs`
/** Whether a run is still being worked on in the background. */
const inProgress = (run: RunDto) =>
  run.status === 'queued' || run.status === 'running' || run.approval === 'approving'

export function useRecipes() {
  return useQuery({
    queryKey: ['recipes'] as const,
    queryFn: () => apiRequest<{ recipes: RecipeDto[] }>('/recipes').then((r) => r.recipes),
  })
}

export function useRuns(slug: string) {
  return useQuery({
    queryKey: runsKey(slug),
    queryFn: () => apiRequest<{ runs: RunDto[] }>(runsPath(slug)).then((r) => r.runs),
    refetchInterval: (query) => (query.state.data?.some(inProgress) ? PENDING_POLL_MS : false),
  })
}

/** How long the page keeps looking for a revision the PM asked for. */
export const REVISION_WAIT_MS = 120_000

/** What the page was showing when a change was asked: a run stays `ready` while it is revised. */
export interface AwaitedRevision {
  readonly revision: number
  readonly revisionError: string | null
  readonly until: number
}

const awaitedRevisionKey = (slug: string, id: string) =>
  ['projects', slug, 'awaited-revision', id] as const

/** Whether the revision asked for has not arrived yet: neither a new one nor a refusal. */
export function awaitsRevision(
  view: Pick<RunViewDto, 'revision'> & { run: Pick<RunDto, 'revisionError'> },
  awaited: AwaitedRevision | undefined,
  now: number,
): boolean {
  return (
    awaited !== undefined &&
    now < awaited.until &&
    view.revision === awaited.revision &&
    view.run.revisionError === awaited.revisionError
  )
}

export function useRun(slug: string, id: string) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: [...runsKey(slug), id],
    queryFn: () => apiRequest<RunViewDto>(`${runsPath(slug)}/${id}`),
    refetchInterval: (query) => {
      const view = query.state.data
      if (!view) return false
      const awaited = queryClient.getQueryData<AwaitedRevision>(awaitedRevisionKey(slug, id))
      return inProgress(view.run) || awaitsRevision(view, awaited, Date.now())
        ? PENDING_POLL_MS
        : false
    },
  })
}

function useRunMutation<I, O>(slug: string, call: (input: I, csrfToken: string) => Promise<O>) {
  const { csrfToken } = useSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: I) => call(input, csrfToken),
    onSettled: () => queryClient.invalidateQueries({ queryKey: runsKey(slug) }),
  })
}

export function useStartRun(slug: string) {
  return useRunMutation(
    slug,
    (input: { recipeSlug: string; parameters: Record<string, unknown> }, csrfToken) =>
      apiRequest<RunDto>(runsPath(slug), { method: 'POST', body: input, csrfToken }),
  )
}

export function useAcceptFinding(slug: string, id: string) {
  return useRunMutation(
    slug,
    (input: { code: string; refKey: string; reason: string }, csrfToken) =>
      apiRequest<RunViewDto>(`${runsPath(slug)}/${id}/acceptances`, {
        method: 'POST',
        body: input,
        csrfToken,
      }),
  )
}

export function useRequestChange(slug: string, id: string) {
  const queryClient = useQueryClient()
  return useRunMutation(slug, async (input: { slots: string[]; request: string }, csrfToken) => {
    const shown = queryClient.getQueryData<RunViewDto>([...runsKey(slug), id])
    await apiRequest<void>(`${runsPath(slug)}/${id}/changes`, {
      method: 'POST',
      body: input,
      csrfToken,
    })
    if (shown) {
      queryClient.setQueryData<AwaitedRevision>(awaitedRevisionKey(slug, id), {
        revision: shown.revision,
        revisionError: shown.run.revisionError,
        until: Date.now() + REVISION_WAIT_MS,
      })
    }
  })
}

export function useApproveRun(slug: string, id: string) {
  return useRunMutation(slug, (_input: undefined, csrfToken) =>
    apiRequest<void>(`${runsPath(slug)}/${id}/approval`, { method: 'POST', csrfToken }),
  )
}

export async function signOut(): Promise<void> {
  const { redirectTo } = await apiRequest<{ redirectTo: string }>('/auth/logout', {
    method: 'POST',
  })
  window.location.assign(redirectTo)
}
