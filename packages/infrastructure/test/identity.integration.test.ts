import { randomUUID } from 'node:crypto'
import type { LoginIdentity } from '@octobrief/application'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import { createLoginAttemptStore, createSessionStore } from '../src/postgres/session-store.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'

const { DATABASE_OWNER_URL, DATABASE_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL)
const HOUR_MS = 3_600_000

function identity(tag: string, overrides: Partial<LoginIdentity> = {}): LoginIdentity {
  return {
    externalSubject: `https://issuer.test|${tag}`,
    displayName: `Person ${tag}`,
    email: `${tag}@Example.test`,
    emailVerified: true,
    ...overrides,
  }
}

describe.skipIf(!hasDatabase)('identity and projects on Postgres (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const users = createUserRepository(pool)
  const sessions = createSessionStore(pool)
  const attempts = createLoginAttemptStore(pool)
  const projects = createProjectRepository(pool)
  const run = randomUUID().slice(0, 8)
  const now = new Date()

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('migrations are idempotent', async () => {
    expect(await runMigrations(DATABASE_OWNER_URL as string)).toEqual([])
  })

  it('upserts users, promotes without demoting, finds verified emails only', async () => {
    const created = await users.upsertFromLogin(identity(`u-${run}`), false)
    expect(created).toMatchObject({ role: 'pm', locale: 'it', email: `u-${run}@example.test` })
    const promoted = await users.upsertFromLogin(identity(`u-${run}`), true)
    expect(promoted).toMatchObject({ id: created.id, role: 'admin' })
    const again = await users.upsertFromLogin(identity(`u-${run}`, { displayName: 'New' }), false)
    expect(again).toMatchObject({ role: 'admin', displayName: 'New' })
    expect((await users.findByEmail(`U-${run}@example.test`))?.id).toBe(created.id)

    await users.upsertFromLogin(identity(`x-${run}`, { emailVerified: false }), false)
    expect(await users.findByEmail(`x-${run}@example.test`)).toBeNull()

    await users.updateLocale(created.id, 'en')
    expect((await users.findByEmail(`u-${run}@example.test`))?.locale).toBe('en')
  })

  it('stores sessions by hash, expires and revokes them', async () => {
    const user = await users.upsertFromLogin(identity(`s-${run}`), false)
    const { token, csrfToken } = await sessions.create(user.id, new Date(now.getTime() + HOUR_MS))
    const found = await sessions.find(token, now)
    expect(found).toMatchObject({ user: { id: user.id }, csrfToken })
    expect(await sessions.find(token, new Date(now.getTime() + 2 * HOUR_MS))).toBeNull()
    const stored = await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token])
    expect(stored.rowCount).toBe(0)
    await sessions.revoke(token)
    expect(await sessions.find(token, now)).toBeNull()
  })

  it('hands out a login attempt once and never after expiry', async () => {
    const attempt = { codeVerifier: 'cv', state: 'st', nonce: 'nn', returnTo: '/x' }
    const id = await attempts.save(attempt, new Date(now.getTime() + HOUR_MS))
    expect(await attempts.take(id, now)).toEqual(attempt)
    expect(await attempts.take(id, now)).toBeNull()
    const late = await attempts.save(attempt, new Date(now.getTime() - 1))
    expect(await attempts.take(late, now)).toBeNull()
  })

  it('creates projects with their owner and manages members', async () => {
    const owner = await users.upsertFromLogin(identity(`o-${run}`), false)
    const other = await users.upsertFromLogin(identity(`m-${run}`), false)
    const slug = `p-${run}`
    const project = await projects.create({ slug, name: 'Alpha', client: null, ownerId: owner.id })
    expect(await projects.slugsStartingWith(slug)).toEqual(new Set([slug]))
    expect(await projects.slugsStartingWith('p_%')).toEqual(new Set())
    expect((await projects.findBySlug(slug, owner.id))?.memberRole).toBe('owner')
    expect((await projects.findBySlug(slug, other.id))?.memberRole).toBeNull()
    expect(await projects.findBySlug(`missing-${run}`, owner.id)).toBeNull()

    expect(await projects.addMember(project.id, other.id, 'member')).toBe(true)
    expect(await projects.addMember(project.id, other.id, 'member')).toBe(false)
    const members = await projects.listMembers(project.id)
    expect(members.map((m) => m.role)).toEqual(['owner', 'member'])

    const visible = await projects.listVisible(other.id, false)
    expect(visible.some((p) => p.slug === slug)).toBe(true)
    const outsider = await users.upsertFromLogin(identity(`z-${run}`), false)
    expect((await projects.listVisible(outsider.id, false)).some((p) => p.slug === slug)).toBe(
      false,
    )
    expect((await projects.listVisible(outsider.id, true)).some((p) => p.slug === slug)).toBe(true)

    await expect(
      projects.create({ slug, name: 'Dup', client: null, ownerId: owner.id }),
    ).rejects.toThrow()
  })
})
