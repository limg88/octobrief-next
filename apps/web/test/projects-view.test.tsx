import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProjectsView } from '@/components/projects/ProjectsView'
import { ALPHA, mockApi, PAOLA, renderWithProviders } from './support/render'
import { resetRouter, router } from './support/router'

describe('ProjectsView', () => {
  beforeEach(() => resetRouter('/'))

  it('lists the visible projects with the viewer role', async () => {
    mockApi({ 'GET /api/projects': () => Response.json({ projects: [ALPHA] }) })
    renderWithProviders(<ProjectsView />)
    expect(await screen.findByRole('link', { name: /Alpha/ })).toHaveAttribute(
      'href',
      '/projects/alpha',
    )
    expect(screen.getByText('Responsabile')).toBeInTheDocument()
    expect(screen.getByText('I progetti di cui fai parte.')).toBeInTheDocument()
  })

  it('shows the empty state and the admin subtitle', async () => {
    mockApi({ 'GET /api/projects': () => Response.json({ projects: [] }) })
    renderWithProviders(<ProjectsView />, {
      user: { ...PAOLA, role: 'admin' },
      csrfToken: 'c',
    })
    expect(await screen.findByText(/Nessun progetto ancora/)).toBeInTheDocument()
    expect(screen.getByText(/sei amministratore/)).toBeInTheDocument()
  })

  it('shows a generic error when the list fails', async () => {
    mockApi({ 'GET /api/projects': () => Response.json({ error: 'internal' }, { status: 500 }) })
    renderWithProviders(<ProjectsView />)
    expect(await screen.findByText(/Qualcosa è andato storto/, {}, { timeout: 3000 })).toBeVisible()
  })

  it('opens «New project» through the URL', async () => {
    mockApi({ 'GET /api/projects': () => Response.json({ projects: [] }) })
    renderWithProviders(<ProjectsView />)
    await userEvent.click(screen.getByRole('button', { name: /Nuovo progetto/ }))
    expect(router.replace).toHaveBeenCalledWith('/?new=1')
  })

  it('creates a project and opens it', async () => {
    window.history.replaceState(null, '', '/?new=1')
    const calls = mockApi({
      'GET /api/projects': () => Response.json({ projects: [] }),
      'POST /api/projects': () =>
        Response.json({ ...ALPHA, name: 'Beta', slug: 'beta' }, { status: 201 }),
    })
    renderWithProviders(<ProjectsView />)
    await userEvent.type(screen.getByLabelText('Nome del progetto'), 'Beta')
    await userEvent.type(screen.getByLabelText('Cliente (facoltativo)'), 'ACME')
    await userEvent.click(screen.getByRole('button', { name: 'Crea progetto' }))
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/projects/beta'))
    expect(screen.getByText('Progetto «Beta» creato')).toBeInTheDocument()
    const post = calls.find((c) => c.key === 'POST /api/projects')
    expect(JSON.parse(String(post?.init.body))).toEqual({ name: 'Beta', client: 'ACME' })
    expect(post?.init.headers).toMatchObject({ 'x-csrf-token': 'csrf-1' })
  })

  it('explains a rejected name', async () => {
    window.history.replaceState(null, '', '/?new=1')
    mockApi({
      'GET /api/projects': () => Response.json({ projects: [] }),
      'POST /api/projects': () =>
        Response.json({ error: 'invalid', field: 'name' }, { status: 400 }),
    })
    renderWithProviders(<ProjectsView />)
    await userEvent.type(screen.getByLabelText('Nome del progetto'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Crea progetto' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Il nome è obbligatorio')
  })

  it('shows a generic message for unexpected creation errors', async () => {
    window.history.replaceState(null, '', '/?new=1')
    mockApi({
      'GET /api/projects': () => Response.json({ projects: [] }),
      'POST /api/projects': () => Response.json({ error: 'internal' }, { status: 500 }),
    })
    renderWithProviders(<ProjectsView />)
    await userEvent.type(screen.getByLabelText('Nome del progetto'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Crea progetto' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Qualcosa è andato storto')
  })
})
