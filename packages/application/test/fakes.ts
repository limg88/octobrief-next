import type { JobStatus, Locale, MemberRole, Project, ProjectMember, User } from '@octobrief/domain'
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
import type {
  IdentityProvider,
  LoginIdentity,
  PendingLogin,
} from '../src/ports/identity-provider.ts'
import type { JobQueue } from '../src/ports/job-queue.ts'
import type { Logger } from '../src/ports/logger.ts'
import type { ProjectRepository, ProjectWithRole } from '../src/ports/project-repository.ts'

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
