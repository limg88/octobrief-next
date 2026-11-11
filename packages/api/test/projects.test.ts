import { describe, expect, it } from 'vitest'
import { setup } from './support.ts'

describe('projects API', () => {
  it('requires a session', async () => {
    const { api } = setup()
    expect((await api.request('/api/projects')).status).toBe(401)
  })

  it('creates, lists and reads projects', async () => {
    const { signIn, send } = setup()
    const paola = await signIn()
    const created = await send('/api/projects', 'POST', paola, {
      name: 'Portale Clienti',
      client: 'ACME',
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      slug: 'portale-clienti',
      client: 'ACME',
      memberRole: 'owner',
    })
    const list = (await (await send('/api/projects', 'GET', paola)).json()) as {
      projects: { slug: string }[]
    }
    expect(list.projects.map((p) => p.slug)).toEqual(['portale-clienti'])
    const one = await send('/api/projects/portale-clienti', 'GET', paola)
    expect(await one.json()).toMatchObject({ name: 'Portale Clienti', memberRole: 'owner' })
  })

  it('rejects an invalid name with the field', async () => {
    const { signIn, send } = setup()
    const paola = await signIn()
    const res = await send('/api/projects', 'POST', paola, { name: '   ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid', field: 'name' })
  })

  it('manages members and hides projects from outsiders', async () => {
    const { signIn, send } = setup()
    const marco = await signIn('marco@example.test', 'Marco')
    const paola = await signIn()
    await send('/api/projects', 'POST', paola, { name: 'Alpha' })

    expect((await send('/api/projects/alpha', 'GET', marco)).status).toBe(404)
    const added = await send('/api/projects/alpha/members', 'POST', paola, {
      email: 'marco@example.test',
    })
    expect(added.status).toBe(201)
    const members = (await (await send('/api/projects/alpha/members', 'GET', marco)).json()) as {
      members: { displayName: string; role: string }[]
    }
    expect(members.members.map((m) => [m.displayName, m.role])).toEqual([
      ['Paola Prova', 'owner'],
      ['Marco', 'member'],
    ])
    const again = await send('/api/projects/alpha/members', 'POST', paola, {
      email: 'marco@example.test',
    })
    expect(again.status).toBe(409)
    const byMember = await send('/api/projects/alpha/members', 'POST', marco, {
      email: 'paola.prova@example.test',
    })
    expect(byMember.status).toBe(403)
  })
})
