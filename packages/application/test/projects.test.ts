import type { User } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import {
  addMember,
  createProject,
  getProject,
  listMembers,
  listProjects,
} from '../src/use-cases/projects.ts'
import { InMemoryProjects, InMemoryUsers } from './fakes.ts'

function person(id: string, role: User['role'] = 'pm'): User {
  return { id, displayName: id, email: `${id}@example.test`, role, locale: 'it' }
}

function setup() {
  const users = new InMemoryUsers()
  const deps = { users, projects: new InMemoryProjects(users) }
  const paola = users.add(person('paola'))
  const marco = users.add(person('marco'))
  const alba = users.add(person('alba', 'admin'))
  return { deps, paola, marco, alba }
}

describe('projects', () => {
  it('creates a project owned by its creator with a unique slug', async () => {
    const { deps, paola } = setup()
    const first = await createProject(deps, paola, { name: 'Portale Clienti', client: 'ACME' })
    const second = await createProject(deps, paola, { name: 'Portale clienti' })
    expect(first.slug).toBe('portale-clienti')
    expect(second.slug).toBe('portale-clienti-2')
    const members = await listMembers(deps, paola, first.slug)
    expect(members).toEqual([
      { userId: 'paola', displayName: 'paola', email: 'paola@example.test', role: 'owner' },
    ])
  })

  it('shows members their projects and admins every project', async () => {
    const { deps, paola, marco, alba } = setup()
    await createProject(deps, paola, { name: 'Alpha' })
    expect(await listProjects(deps, paola)).toHaveLength(1)
    expect(await listProjects(deps, marco)).toHaveLength(0)
    const asAdmin = await listProjects(deps, alba)
    expect(asAdmin).toHaveLength(1)
    expect(asAdmin[0]?.memberRole).toBeNull()
  })

  it('hides projects from non-members', async () => {
    const { deps, paola, marco, alba } = setup()
    await createProject(deps, paola, { name: 'Alpha' })
    await expect(getProject(deps, marco, 'alpha')).rejects.toMatchObject({ code: 'not_found' })
    await expect(getProject(deps, paola, 'missing')).rejects.toMatchObject({ code: 'not_found' })
    expect((await getProject(deps, alba, 'alpha')).name).toBe('Alpha')
  })
})

describe('members', () => {
  it('lets owners add people who signed in', async () => {
    const { deps, paola } = setup()
    await createProject(deps, paola, { name: 'Alpha' })
    const members = await addMember(deps, paola, 'alpha', ' MARCO@example.test ')
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      ['paola', 'owner'],
      ['marco', 'member'],
    ])
  })

  it('refuses plain members, unknown people and duplicates', async () => {
    const { deps, paola, marco, alba } = setup()
    await createProject(deps, paola, { name: 'Alpha' })
    await addMember(deps, paola, 'alpha', 'marco@example.test')
    await expect(addMember(deps, marco, 'alpha', 'alba@example.test')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(addMember(deps, paola, 'alpha', 'nobody@example.test')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(addMember(deps, alba, 'alpha', 'marco@example.test')).rejects.toMatchObject({
      code: 'conflict',
    })
  })
})
