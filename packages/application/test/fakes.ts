import { createHash, randomUUID } from 'node:crypto'
import type {
  Classification,
  ClassificationState,
  DocumentKind,
  DocumentSummary,
  Extraction,
  Fact,
  JobStatus,
  KnownPerson,
  Locale,
  MemberRole,
  Project,
  ProjectMember,
  TextChunk,
  User,
} from '@octobrief/domain'
import { ApplicationError } from '../src/errors.ts'
import type { JobData, JobName } from '../src/jobs.ts'
import { JOB_SCHEMAS } from '../src/jobs.ts'
import type {
  ActiveSession,
  LoginAttempt,
  LoginAttemptStore,
  SessionStore,
  UserRepository,
} from '../src/ports/auth-stores.ts'
import type { BlobStore } from '../src/ports/blob-store.ts'
import type {
  DocumentProcessingStore,
  DocumentRepository,
  NewDocument,
} from '../src/ports/document-repository.ts'
import type {
  IdentityProvider,
  LoginIdentity,
  PendingLogin,
} from '../src/ports/identity-provider.ts'
import type { JobQueue } from '../src/ports/job-queue.ts'
import type {
  DocumentToCompile,
  FactRepository,
  FactView,
  KnowledgeChange,
  KnowledgeProgress,
  KnowledgeStatus,
  KnowledgeStore,
} from '../src/ports/knowledge-store.ts'
import type { Logger } from '../src/ports/logger.ts'
import type { EmbeddingModel } from '../src/ports/model-runner.ts'
import type { ProjectRepository, ProjectWithRole } from '../src/ports/project-repository.ts'
import type { TextExtractor } from '../src/ports/text-extractor.ts'

export class InMemoryJobQueue implements JobQueue {
  readonly jobs = new Map<string, { name: JobName; data: unknown; status: JobStatus }>()
  private nextId = 1

  async enqueue<N extends JobName>(name: N, data: JobData[N]): Promise<string> {
    const parsed = JOB_SCHEMAS[name].parse(data)
    const id = `job-${this.nextId++}`
    this.jobs.set(id, { name, data: parsed, status: 'queued' })
    return id
  }

  async status(name: JobName, id: string): Promise<JobStatus | null> {
    const job = this.jobs.get(id)
    return job && job.name === name ? job.status : null
  }
}

export class RecordingLogger implements Logger {
  readonly entries: { level: 'info' | 'error'; message: string; fields?: unknown }[] = []
  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, fields })
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, fields })
  }
}

export class FakeIdentityProvider implements IdentityProvider {
  identity: LoginIdentity = {
    externalSubject: 'https://issuer.test|paola',
    displayName: 'Paola Prova',
    email: 'paola.prova@example.test',
    emailVerified: true,
  }
  lastHint: string | null = null
  async begin(input: { loginHint: string | null }) {
    this.lastHint = input.loginHint
    return {
      authorizationUrl: 'https://issuer.test/authorize',
      pending: { codeVerifier: 'cv', state: 'st', nonce: 'nn' },
    }
  }
  async complete(callbackQuery: string, pending: PendingLogin): Promise<LoginIdentity> {
    if (!callbackQuery.includes(`state=${pending.state}`)) {
      throw new ApplicationError('login_failed', 'state mismatch')
    }
    return this.identity
  }
  async logoutUrl() {
    return 'https://issuer.test/logout'
  }
}

export class InMemoryUsers implements UserRepository {
  readonly bySubject = new Map<string, User>()
  private nextId = 1
  async upsertFromLogin(identity: LoginIdentity, promoteToAdmin: boolean): Promise<User> {
    const existing = this.bySubject.get(identity.externalSubject)
    const user: User = {
      id: existing?.id ?? `user-${this.nextId++}`,
      displayName: identity.displayName,
      email: identity.email?.toLowerCase() ?? null,
      role: promoteToAdmin ? 'admin' : (existing?.role ?? 'pm'),
      locale: existing?.locale ?? 'it',
    }
    this.bySubject.set(identity.externalSubject, user)
    return user
  }
  async findByEmail(email: string) {
    return [...this.bySubject.values()].find((user) => user.email === email) ?? null
  }
  async updateLocale(userId: string, locale: Locale) {
    for (const [key, user] of this.bySubject) {
      if (user.id === userId) this.bySubject.set(key, { ...user, locale })
    }
  }
  add(user: User): User {
    this.bySubject.set(`subject|${user.id}`, user)
    return user
  }
}

export class InMemorySessions implements SessionStore {
  readonly sessions = new Map<string, { userId: string; expiresAt: Date }>()
  private readonly users: InMemoryUsers
  constructor(users: InMemoryUsers) {
    this.users = users
  }
  async create(userId: string, expiresAt: Date) {
    const token = `token-${this.sessions.size + 1}`
    this.sessions.set(token, { userId, expiresAt })
    return { token, csrfToken: `csrf-${token}` }
  }
  async find(token: string, now: Date): Promise<ActiveSession | null> {
    const session = this.sessions.get(token)
    if (!session || session.expiresAt <= now) return null
    const user = [...this.users.bySubject.values()].find((u) => u.id === session.userId)
    return user ? { user, csrfToken: `csrf-${token}`, expiresAt: session.expiresAt } : null
  }
  async revoke(token: string) {
    this.sessions.delete(token)
  }
}

export class InMemoryLoginAttempts implements LoginAttemptStore {
  readonly attempts = new Map<string, { attempt: LoginAttempt; expiresAt: Date }>()
  async save(attempt: LoginAttempt, expiresAt: Date) {
    const id = `attempt-${this.attempts.size + 1}`
    this.attempts.set(id, { attempt, expiresAt })
    return id
  }
  async take(id: string, now: Date) {
    const entry = this.attempts.get(id)
    this.attempts.delete(id)
    return entry && entry.expiresAt > now ? entry.attempt : null
  }
}

export class InMemoryProjects implements ProjectRepository {
  readonly projects: Project[] = []
  readonly members: { projectId: string; userId: string; role: MemberRole }[] = []
  private readonly users: InMemoryUsers
  constructor(users: InMemoryUsers) {
    this.users = users
  }
  private roleOf(projectId: string, userId: string): MemberRole | null {
    return this.members.find((m) => m.projectId === projectId && m.userId === userId)?.role ?? null
  }
  async listVisible(userId: string, all: boolean): Promise<ProjectWithRole[]> {
    return this.projects
      .map((p) => ({ ...p, memberRole: this.roleOf(p.id, userId) }))
      .filter((p) => all || p.memberRole !== null)
  }
  async findBySlug(slug: string, viewerId: string) {
    const project = this.projects.find((p) => p.slug === slug)
    return project ? { ...project, memberRole: this.roleOf(project.id, viewerId) } : null
  }
  async slugsStartingWith(prefix: string) {
    return new Set(this.projects.map((p) => p.slug).filter((s) => s.startsWith(prefix)))
  }
  async create(input: { slug: string; name: string; client: string | null; ownerId: string }) {
    const project: Project = {
      id: `project-${this.projects.length + 1}`,
      slug: input.slug,
      name: input.name,
      client: input.client,
      createdAt: new Date('2026-11-11T10:00:00Z'),
    }
    this.projects.push(project)
    this.members.push({ projectId: project.id, userId: input.ownerId, role: 'owner' })
    return project
  }
  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const users = [...this.users.bySubject.values()]
    return this.members
      .filter((m) => m.projectId === projectId)
      .map((m) => {
        const user = users.find((u) => u.id === m.userId)
        return {
          userId: m.userId,
          displayName: user?.displayName ?? '?',
          email: user?.email ?? null,
          role: m.role,
        }
      })
  }
  async addMember(projectId: string, userId: string, role: MemberRole) {
    if (this.roleOf(projectId, userId) !== null) return false
    this.members.push({ projectId, userId, role })
    return true
  }
}

export class InMemoryBlobs implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>()
  async put(projectId: string, bytes: Uint8Array) {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const key = `${projectId}/${sha256}`
    this.blobs.set(key, bytes)
    return { key, sha256 }
  }
  async get(key: string) {
    const bytes = this.blobs.get(key)
    if (!bytes) throw new Error('missing blob')
    return bytes
  }
  async delete(key: string) {
    this.blobs.delete(key)
  }
}

export class FakeExtractor implements TextExtractor {
  private readonly result: (fileName: string) => Extraction
  constructor(result: (fileName: string) => Extraction) {
    this.result = result
  }
  async extract(_bytes: Uint8Array, _mediaType: string, fileName: string) {
    return this.result(fileName)
  }
}

interface StoredDocument {
  summary: DocumentSummary
  blobKey: string
  chunks: TextChunk[]
  systemKind?: string | null
}

/** Both views of the documents table; `visible` stands in for row-level security. */
export class InMemoryDocuments implements DocumentRepository, DocumentProcessingStore {
  readonly rows = new Map<string, StoredDocument>()
  private readonly projects: InMemoryProjects
  private readonly users: InMemoryUsers
  constructor(projects: InMemoryProjects, users: InMemoryUsers) {
    this.projects = projects
    this.users = users
  }
  visible(viewerId: string, projectId: string): boolean {
    const admin = [...this.users.bySubject.values()].some(
      (u) => u.id === viewerId && u.role === 'admin',
    )
    return (
      admin || this.projects.members.some((m) => m.projectId === projectId && m.userId === viewerId)
    )
  }
  private update(id: string, change: Partial<DocumentSummary>, chunks?: TextChunk[]) {
    const row = this.rows.get(id) as StoredDocument
    this.rows.set(id, {
      ...row,
      summary: { ...row.summary, ...change },
      chunks: chunks ?? row.chunks,
    })
  }
  async create(viewerId: string, document: NewDocument) {
    if (!this.visible(viewerId, document.projectId)) throw new Error('row-level security')
    const duplicate = [...this.rows.values()].some(
      (r) => r.summary.projectId === document.projectId && r.blobKey === document.blobKey,
    )
    if (duplicate) return null
    const summary: DocumentSummary = {
      id: randomUUID(),
      projectId: document.projectId,
      fileName: document.fileName,
      mediaType: document.mediaType,
      sizeBytes: document.sizeBytes,
      status: 'pending',
      kind: null,
      audience: null,
      audienceSource: null,
      documentDate: null,
      dateSource: null,
      uncertain: [],
      warnings: [],
      chunkCount: 0,
      uploadedBy: document.uploadedBy,
      uploaderName: document.uploadedBy,
      uploadedAt: new Date('2026-11-11T10:00:00Z'),
      sourceName: null,
      originAt: null,
    }
    this.rows.set(summary.id, { summary, blobKey: document.blobKey, chunks: [] })
    return summary
  }
  async list(viewerId: string, projectId: string) {
    if (!this.visible(viewerId, projectId)) return []
    return [...this.rows.values()]
      .filter((r) => r.summary.projectId === projectId)
      .map((r) => r.summary)
  }
  async find(viewerId: string, projectId: string, documentId: string) {
    const row = this.rows.get(documentId)
    if (!row || row.summary.projectId !== projectId || !this.visible(viewerId, projectId))
      return null
    return row.summary
  }
  async chunks(_viewerId: string, documentId: string, limit: number) {
    return (this.rows.get(documentId)?.chunks ?? []).slice(0, limit)
  }
  async saveClassification(_viewerId: string, documentId: string, state: ClassificationState) {
    this.update(documentId, { ...state, uncertain: [...state.uncertain] })
    return (this.rows.get(documentId) as StoredDocument).summary
  }
  async remove(_viewerId: string, documentId: string) {
    const row = this.rows.get(documentId)
    this.rows.delete(documentId)
    return row?.blobKey ?? null
  }
  async pending(documentId: string) {
    const row = this.rows.get(documentId)
    if (row?.summary.status !== 'pending') return null
    const { id, fileName, mediaType, uploadedAt, originAt } = row.summary
    return {
      id,
      fileName,
      mediaType,
      uploadedAt,
      blobKey: row.blobKey,
      originAt,
      systemKind: (row.systemKind ?? null) as DocumentKind | null,
    }
  }
  async markReady(documentId: string, extraction: Extraction, classification: Classification) {
    this.update(
      documentId,
      {
        status: 'ready',
        kind: classification.kind,
        audience: classification.audience,
        audienceSource: classification.audienceSource,
        documentDate: classification.dateOf.date,
        dateSource: classification.dateOf.source,
        uncertain: classification.uncertain,
        warnings: extraction.warnings,
        chunkCount: extraction.chunks.length,
      },
      extraction.chunks,
    )
  }
  async markFailed(documentId: string, extraction: Extraction) {
    this.update(documentId, { status: 'failed', warnings: extraction.warnings })
  }
  async expired(cutoff: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.summary.uploadedAt < cutoff)
      .slice(0, limit)
      .map((r) => ({ id: r.summary.id, blobKey: r.blobKey }))
  }
  async removeExpired(documentId: string) {
    this.rows.delete(documentId)
  }
}

/** Both views of the knowledge, over the in-memory documents. */
export class InMemoryKnowledge implements KnowledgeStore, FactRepository {
  readonly stored: Fact[] = []
  readonly status = new Map<string, { status: KnowledgeStatus; error?: string }>()
  readonly embeddings = new Map<string, { encoder: EmbeddingModel; vectors: number[][] }>()
  knownPeople: KnownPerson[] = []
  private readonly documents: InMemoryDocuments
  constructor(documents: InMemoryDocuments) {
    this.documents = documents
  }
  async compilable(documentId: string): Promise<DocumentToCompile | null> {
    const row = this.documents.rows.get(documentId)
    const { summary } = row ?? {}
    if (!row || !summary || summary.status !== 'ready') return null
    if (this.status.get(documentId)?.status === 'ready') return null
    if (!summary.kind || !summary.audience || !summary.audienceSource) return null
    if (!summary.documentDate || !summary.dateSource) return null
    return {
      id: summary.id,
      projectId: summary.projectId,
      fileName: summary.fileName,
      uploadedBy: summary.uploadedBy,
      classification: {
        kind: summary.kind,
        audience: summary.audience,
        audienceSource: summary.audienceSource,
        dateOf: { date: summary.documentDate, source: summary.dateSource },
        uncertain: [...summary.uncertain],
      },
      chunks: row.chunks,
    }
  }
  async facts(projectId: string) {
    return this.stored.filter((fact) => fact.projectId === projectId)
  }
  async people() {
    return this.knownPeople
  }
  async saveEmbeddings(documentId: string, encoder: EmbeddingModel, vectors: number[][]) {
    this.embeddings.set(documentId, { encoder, vectors })
  }
  private patch(factId: string, change: (fact: Fact) => Fact) {
    const at = this.stored.findIndex((fact) => fact.id === factId)
    if (at >= 0) this.stored[at] = change(this.stored[at] as Fact)
  }
  readonly suspicious = new Set<string>()
  async saveKnowledge(documentId: string, changes: readonly KnowledgeChange[], suspicious = false) {
    if (suspicious) this.suspicious.add(documentId)
    for (const change of changes) {
      if (change.kind === 'insert') this.stored.push(change.fact)
      if (change.kind === 'add_sources') {
        this.patch(change.factId, (f) => ({ ...f, sources: [...f.sources, ...change.sources] }))
      }
      if (change.kind === 'replace') {
        const { statement, value, sources } = change.proposed
        this.patch(change.factId, (f) => ({ ...f, statement, value, sources, state: 'active' }))
      }
      if (change.kind === 'contest') {
        this.patch(change.factId, (f) => ({ ...f, state: 'contested' }))
        this.stored.push(change.fact)
      }
    }
    this.status.set(documentId, { status: 'ready' })
  }
  async markKnowledgeFailed(documentId: string, code: string) {
    this.status.set(documentId, { status: 'failed', error: code })
  }
  async list(viewerId: string, projectId: string): Promise<FactView[]> {
    if (!this.documents.visible(viewerId, projectId)) return []
    return this.stored
      .filter((fact) => fact.projectId === projectId)
      .map((fact) => ({
        id: fact.id,
        kind: fact.kind,
        key: fact.key,
        statement: fact.statement,
        value: fact.value,
        state: fact.state,
        createdAt: fact.createdAt,
        sources: fact.sources.map((source) => ({
          documentId: source.evidenceId,
          fileName: this.documents.rows.get(source.evidenceId)?.summary.fileName ?? '',
          locator: source.locator,
          excerpt: source.excerpt,
        })),
      }))
  }
  async progress(viewerId: string, projectId: string): Promise<KnowledgeProgress> {
    const progress = { reading: 0, failed: 0, compiled: 0 }
    if (!this.documents.visible(viewerId, projectId)) return progress
    for (const { summary } of this.documents.rows.values()) {
      if (summary.projectId !== projectId || summary.status === 'failed') continue
      const status = this.status.get(summary.id)?.status
      if (status === 'ready') progress.compiled++
      else if (status === 'failed') progress.failed++
      else progress.reading++
    }
    return progress
  }
}

export { InMemoryQuestions, readingOf } from './question-fakes.ts'
export { FakeFeeds, FakeVault, InMemorySources } from './source-fakes.ts'
