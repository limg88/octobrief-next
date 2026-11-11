import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioShell } from '@/components/shell/StudioShell'
import { ALPHA, mockApi, PAOLA, renderWithProviders } from './support/render'
import { resetRouter, router } from './support/router'

const SESSION = { user: { ...PAOLA, role: 'admin' as const }, csrfToken: 'csrf-1' }

function renderShell() {
  const calls = mockApi({
    'GET /api/projects': () =>
      Response.json({
        projects: [ALPHA, { ...ALPHA, id: 'p-2', slug: 'beta', name: 'Beta', client: null }],
      }),
    'PATCH /api/me': () => new Response(null, { status: 204 }),
    'POST /api/auth/logout': () => Response.json({ redirectTo: 'http://issuer.test/logout' }),
  })
  renderWithProviders(
    <StudioShell session={SESSION}>
      <p>page content</p>
    </StudioShell>,
  )
  return calls
}

async function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  return screen.findByPlaceholderText('Scrivi un comando o cerca…')
}

describe('StudioShell', () => {
  beforeEach(() => resetRouter('/projects/alpha/ask'))

  it('renders the sidebar with the sections of the current project', async () => {
    renderShell()
    expect(screen.getByText('page content')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Chiedi/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /Memoria/ })).toHaveAttribute(
      'href',
      '/projects/alpha/memory',
    )
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
  })

  it('navigates with G then a section key', () => {
    renderShell()
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'd' })
    expect(router.push).toHaveBeenCalledWith('/projects/alpha/deliverables')
  })

  it('opens the palette with ⌘K and the search button, and jumps to a project', async () => {
    renderShell()
    await openPalette()
    await userEvent.click(await screen.findByRole('option', { name: /Beta/ }))
    expect(router.push).toHaveBeenCalledWith('/projects/beta')
    await userEvent.click(screen.getByRole('button', { name: 'Cerca e comandi' }))
    await userEvent.click(await screen.findByRole('option', { name: /Memoria/ }))
    expect(router.push).toHaveBeenCalledWith('/projects/alpha/memory')
  })

  it('creates a project and switches language from the palette', async () => {
    const calls = renderShell()
    await openPalette()
    await userEvent.click(screen.getByRole('option', { name: /Nuovo progetto/ }))
    expect(router.push).toHaveBeenCalledWith('/?new=1')
    await openPalette()
    await userEvent.click(screen.getByRole('option', { name: /Switch to English/ }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalled())
    const patch = calls.find((c) => c.key === 'PATCH /api/me')
    expect(JSON.parse(String(patch?.init.body))).toEqual({ locale: 'en' })
  })

  it('toggles the theme from the palette', async () => {
    renderShell()
    await openPalette()
    await userEvent.click(screen.getByRole('option', { name: /Cambia tema/ }))
    await waitFor(() => expect(document.documentElement).toHaveClass('light'))
  })

  it('signs out from the palette', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const calls = renderShell()
    await openPalette()
    await userEvent.click(screen.getByRole('option', { name: /Esci/ }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://issuer.test/logout'))
    expect(calls.some((c) => c.key === 'POST /api/auth/logout')).toBe(true)
  })

  it('shows the user menu with theme and language', async () => {
    const calls = renderShell()
    await userEvent.click(screen.getByRole('button', { name: /Paola Prova/ }))
    expect(await screen.findByText('paola.prova@example.test')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /Lingua/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }))
    await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/me')).toBe(true))
  })

  it('switches project from the sidebar menu', async () => {
    renderShell()
    await screen.findByText('Alpha')
    await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Beta' }))
    expect(router.push).toHaveBeenCalledWith('/projects/beta')
    await userEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Tutti i progetti' }))
    expect(router.push).toHaveBeenCalledWith('/')
  })

  it('works outside a project', async () => {
    resetRouter('/')
    act(() => {
      renderShell()
    })
    expect(screen.queryByRole('link', { name: /Chiedi/ })).not.toBeInTheDocument()
    expect(screen.getByText('Scegli un progetto')).toBeInTheDocument()
  })
})
