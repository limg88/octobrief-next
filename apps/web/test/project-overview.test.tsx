import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProjectOverview } from '@/components/projects/ProjectOverview'
import type { MemberDto } from '@/lib/api-types'
import { ALPHA, mockApi, PAOLA, renderWithProviders } from './support/render'
import { resetRouter } from './support/router'

const OWNER: MemberDto = {
  userId: 'u-paola',
  displayName: 'Paola Prova',
  email: 'paola.prova@example.test',
  role: 'owner',
}
const MARCO: MemberDto = {
  userId: 'u-marco',
  displayName: 'Marco Esempio',
  email: 'marco.esempio@example.test',
  role: 'member',
}

function api(addMember: () => Response, project = ALPHA) {
  return mockApi({
    'GET /api/projects/alpha': () => Response.json(project),
    'GET /api/projects/alpha/members': () => Response.json({ members: [OWNER] }),
    'POST /api/projects/alpha/members': addMember,
  })
}

describe('ProjectOverview', () => {
  beforeEach(() => resetRouter('/projects/alpha'))

  it('shows the project, its client, creation date and members', async () => {
    api(() => Response.json({ members: [] }))
    renderWithProviders(<ProjectOverview slug="alpha" />)
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByText(/ACME · Creato il 11 novembre 2026/)).toBeInTheDocument()
    expect(await screen.findByText('paola.prova@example.test')).toBeInTheDocument()
  })

  it('lets the owner add a member', async () => {
    const calls = api(() => Response.json({ members: [OWNER, MARCO] }, { status: 201 }))
    renderWithProviders(<ProjectOverview slug="alpha" />)
    await userEvent.type(
      await screen.findByLabelText(/Email di una persona/),
      'marco.esempio@example.test',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))
    expect(await screen.findByText('Marco Esempio')).toBeInTheDocument()
    expect(screen.getByText('Membro aggiunto')).toBeInTheDocument()
    const post = calls.find((c) => c.key === 'POST /api/projects/alpha/members')
    expect(JSON.parse(String(post?.init.body))).toEqual({ email: 'marco.esempio@example.test' })
  })

  it.each([
    ['conflict', 409, 'È già membro'],
    ['not_found', 404, 'Nessuna persona con questa email'],
    ['internal', 500, 'Qualcosa è andato storto'],
  ])('explains a %s failure', async (error, status, message) => {
    api(() => Response.json({ error }, { status }))
    renderWithProviders(<ProjectOverview slug="alpha" />)
    await userEvent.type(await screen.findByLabelText(/Email di una persona/), 'x@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('hides the form from plain members', async () => {
    api(() => Response.json({}), { ...ALPHA, client: null, memberRole: 'member' })
    renderWithProviders(<ProjectOverview slug="alpha" />, {
      user: { ...PAOLA, id: 'u-marco' },
      csrfToken: 'c',
    })
    expect(await screen.findByText(/Solo il responsabile del progetto/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Aggiungi' })).not.toBeInTheDocument()
  })

  it('says when the project is not visible', async () => {
    mockApi({})
    renderWithProviders(<ProjectOverview slug="alpha" />)
    expect(
      await screen.findByText('Progetto non trovato o non visibile.', {}, { timeout: 3000 }),
    ).toBeInTheDocument()
  })
})
