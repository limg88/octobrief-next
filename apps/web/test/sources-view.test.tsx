import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pullSettings, SourcesView, sourceErrorKey } from '@/components/sources/SourcesView'
import { ApiError } from '@/lib/api-client'
import type { SourceDto } from '@/lib/api-types'
import { mockApi, renderWithProviders } from './support/render'
import { resetRouter } from './support/router'

const BASE = '/api/projects/alpha/sources'

const JIRA: SourceDto = {
  id: 's-1',
  kind: 'jira',
  feed: 'direct',
  folderPath: null,
  name: 'Jira Borea',
  perimeter: ['project:10001'],
  lastSyncAt: '2026-11-12T09:00:00.000Z',
  dataAsOf: '2026-11-12T08:55:00.000Z',
  lastError: 'source_auth_failed',
  documentCount: 3,
  createdAt: '2026-11-11T10:00:00.000Z',
}
const MAIL: SourceDto = {
  ...JIRA,
  id: 's-2',
  kind: 'm365',
  feed: 'push',
  name: 'Posta',
  lastSyncAt: null,
  dataAsOf: null,
  lastError: null,
  documentCount: 0,
}

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string)

describe('SourcesView', () => {
  beforeEach(() => resetRouter('/projects/alpha/sources'))

  it('lists sources with their freshness, their last failure and the right action', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [JIRA, MAIL] }),
      [`POST ${BASE}/s-1/sync`]: () => new Response(null, { status: 202 }),
      [`POST ${BASE}/s-2/token`]: () => Response.json({ ingestToken: 'obf_nuovo' }),
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    const jira = (await screen.findByText('Jira Borea')).closest('tr') as HTMLElement
    expect(within(jira).getByText('3')).toBeTruthy()
    expect(within(jira).getByRole('alert').textContent).toContain('source_auth_failed')
    const mail = screen.getByText('Posta').closest('tr') as HTMLElement
    expect(within(mail).getAllByText('mai')).toHaveLength(2)

    await userEvent.click(within(jira).getByRole('button', { name: 'Leggi ora' }))
    await userEvent.click(within(mail).getByRole('button', { name: 'Nuovo token' }))
    expect(await screen.findByText('obf_nuovo')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: "L'ho copiato" }))
    expect(screen.queryByText('obf_nuovo')).toBeNull()
    expect(calls.map((call) => call.key)).toContain(`POST ${BASE}/s-1/sync`)
  })

  it('connects a feeder source and shows its token once', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [] }),
      [`POST ${BASE}`]: () =>
        Response.json(
          { source: { ...MAIL, name: 'Cartella' }, ingestToken: 'obf_uno' },
          { status: 201 },
        ),
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    expect(await screen.findByText('Nessuna fonte collegata.')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Nome della fonte'), 'Cartella')
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }))
    expect(await screen.findByText('obf_uno')).toBeTruthy()
    const post = calls.find((call) => call.key === `POST ${BASE}`)
    expect(bodyOf(post?.init as RequestInit)).toEqual({ kind: 'files', name: 'Cartella' })
  })

  it('asks a Jira source for site, account, projects and a read-only token', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [] }),
      [`POST ${BASE}`]: () =>
        Response.json({ error: 'invalid', reason: 'source_auth_failed' }, { status: 400 }),
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    await userEvent.selectOptions(await screen.findByLabelText('Tipo di fonte'), 'jira')
    await userEvent.type(screen.getByLabelText('Nome della fonte'), 'Jira')
    await userEvent.type(
      screen.getByLabelText('Sito Jira (il nome prima di .atlassian.net)'),
      'contoso',
    )
    await userEvent.type(screen.getByLabelText("Email dell'account"), 'pm@example.test')
    await userEvent.type(screen.getByLabelText(/Chiavi dei progetti/), 'BOR, APO')
    await userEvent.type(screen.getByLabelText('Token in sola lettura'), 'segreto')
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }))
    await waitFor(() => expect(calls.some((call) => call.key === `POST ${BASE}`)).toBe(true))
    const post = calls.find((call) => call.key === `POST ${BASE}`)
    expect(bodyOf(post?.init as RequestInit)).toEqual({
      kind: 'jira',
      name: 'Jira',
      config: { site: 'contoso', email: 'pm@example.test', readOnlyToken: true },
      scope: ['BOR', 'APO'],
      secret: 'segreto',
    })
    expect(await screen.findByText('Il sistema ha rifiutato le credenziali.')).toBeTruthy()
  })

  it('connects a synchronized folder the server reads: one source for each system', async () => {
    const created: Array<Record<string, unknown>> = []
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [] }),
      [`POST ${BASE}`]: (init) => {
        const body = bodyOf(init)
        created.push(body)
        return Response.json(
          { source: { ...JIRA, ...body, id: `s-${created.length}` }, ingestToken: null },
          { status: 201 },
        )
      },
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    const form = (await screen.findByText('Collega una cartella sincronizzata')).closest(
      'form',
    ) as HTMLElement
    await userEvent.type(
      within(form).getByLabelText('Percorso della cartella sul server'),
      '/sync/borea',
    )
    await userEvent.click(within(form).getByLabelText('NetSuite'))
    await userEvent.click(within(form).getByLabelText('Altri file'))
    await userEvent.click(within(form).getByRole('button', { name: 'Collega la cartella' }))
    await screen.findByText('Cartella collegata')
    expect(created).toEqual([
      {
        kind: 'm365',
        name: 'Microsoft 365 (cartella sincronizzata)',
        feed: 'folder',
        folderPath: '/sync/borea',
      },
      {
        kind: 'files',
        name: 'Altri file (cartella sincronizzata)',
        feed: 'folder',
        folderPath: '/sync/borea',
      },
      {
        kind: 'jira',
        name: 'Jira (cartella sincronizzata)',
        feed: 'folder',
        folderPath: '/sync/borea',
      },
      {
        kind: 'ado',
        name: 'Azure DevOps (cartella sincronizzata)',
        feed: 'folder',
        folderPath: '/sync/borea',
      },
    ])
  })

  it('prepares what the add-on needs when the folder is sent from the PC', async () => {
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [] }),
      [`POST ${BASE}`]: (init) => {
        const body = bodyOf(init)
        return Response.json(
          { source: { ...JIRA, ...body, id: `id-${body.kind}` }, ingestToken: `obf_${body.kind}` },
          { status: 201 },
        )
      },
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    const form = (await screen.findByText('Collega una cartella sincronizzata')).closest(
      'form',
    ) as HTMLElement
    await userEvent.selectOptions(within(form).getByLabelText('Come arriva la cartella'), 'push')
    expect(within(form).queryByLabelText('Percorso della cartella sul server')).toBeNull()
    for (const system of ['Azure DevOps', 'Microsoft 365', 'NetSuite']) {
      await userEvent.click(within(form).getByLabelText(system))
    }
    await userEvent.click(within(form).getByRole('button', { name: 'Collega la cartella' }))
    const setup = (await screen.findByText(/Da copiare ora nella configurazione/)).closest(
      'div',
    ) as HTMLElement
    expect(setup.textContent).toContain('"id": "id-jira"')
    expect(setup.textContent).toContain('"tokenEnv": "OCTOBRIEF_TOKEN_JIRA"')
    expect(setup.textContent).toContain('OCTOBRIEF_TOKEN_JIRA=obf_jira')
    await userEvent.click(within(setup).getByRole('button', { name: "L'ho copiato" }))
    expect(screen.queryByText(/Da copiare ora nella configurazione/)).toBeNull()
  })

  it('says why a folder is refused, and shows how each source is fed', async () => {
    mockApi({
      [`GET ${BASE}`]: () =>
        Response.json({
          sources: [
            { ...JIRA, feed: 'folder', folderPath: '/sync/borea', lastError: null },
            { ...JIRA, id: 's-3', name: 'ADO dal PC', kind: 'ado', feed: 'push', lastError: null },
          ],
        }),
      [`POST ${BASE}`]: () =>
        Response.json({ error: 'invalid', reason: 'folder_not_allowed' }, { status: 400 }),
    })
    renderWithProviders(<SourcesView slug="alpha" />)
    const fromFolder = (await screen.findByText('Jira Borea')).closest('tr') as HTMLElement
    expect(fromFolder.textContent).toContain('Jira · dalla cartella /sync/borea')
    expect(within(fromFolder).getByRole('button', { name: 'Leggi ora' })).toBeTruthy()
    const pushed = screen.getByText('ADO dal PC').closest('tr') as HTMLElement
    expect(pushed.textContent).toContain('Azure DevOps · inviato dal PC')
    expect(within(pushed).getByRole('button', { name: 'Nuovo token' })).toBeTruthy()

    const form = screen
      .getByText('Collega una cartella sincronizzata')
      .closest('form') as HTMLElement
    await userEvent.type(within(form).getByLabelText('Percorso della cartella sul server'), '/etc')
    await userEvent.click(within(form).getByRole('button', { name: 'Collega la cartella' }))
    await screen.findByText(/fuori dalla posizione consentita/)
  })

  it('disconnects a source after a confirmation', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ sources: [MAIL] }),
      [`DELETE ${BASE}/s-2`]: () => new Response(null, { status: 204 }),
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderWithProviders(<SourcesView slug="alpha" />)
    const button = await screen.findByRole('button', { name: 'Scollega' })
    await userEvent.click(button)
    expect(calls.some((call) => call.key.startsWith('DELETE'))).toBe(false)
    await userEvent.click(button)
    await waitFor(() => expect(calls.some((call) => call.key === `DELETE ${BASE}/s-2`)).toBe(true))
    confirm.mockRestore()
  })

  it('maps settings and failures', () => {
    expect(pullSettings('ado', '', 'contoso', ' Borea ')).toEqual({
      config: { organization: 'contoso', host: 'dev.azure.com', readOnlyToken: true },
      scope: ['Borea'],
    })
    expect(sourceErrorKey(new ApiError(409, 'conflict'))).toBe('conflict')
    expect(sourceErrorKey(new ApiError(400, 'invalid', undefined, 'secret_required'))).toBe(
      'secret_required',
    )
    expect(sourceErrorKey(new ApiError(500, 'internal'))).toBeNull()
    expect(sourceErrorKey(new Error('x'))).toBeNull()
  })
})
