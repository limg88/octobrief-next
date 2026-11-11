import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryView } from '@/components/memory/MemoryView'
import type { DocumentDto } from '@/lib/api-types'
import { mockApi, renderWithProviders } from './support/render'
import { resetRouter } from './support/router'

const BASE = '/api/projects/alpha/documents'

const SAL: DocumentDto = {
  id: 'd-1',
  fileName: 'SAL-Aurora-2026-11-04.md',
  mediaType: 'text/markdown',
  sizeBytes: 2048,
  status: 'ready',
  kind: 'status_report',
  audience: 'internal',
  audienceSource: 'default',
  documentDate: '2026-11-03T23:00:00.000Z',
  dateSource: 'file_name',
  uncertain: ['audience'],
  warnings: [],
  chunkCount: 3,
  uploadedBy: 'u-paola',
  uploaderName: 'Paola Prova',
  uploadedAt: '2026-11-11T10:00:00.000Z',
}

const PENDING: DocumentDto = {
  ...SAL,
  id: 'd-2',
  fileName: 'nota.txt',
  status: 'pending',
  kind: null,
  audience: null,
  audienceSource: null,
  documentDate: null,
  dateSource: null,
  uncertain: [],
  chunkCount: 0,
}

describe('MemoryView', () => {
  beforeEach(() => resetRouter('/projects/alpha/memory'))

  it('lists documents with classification, date source and what to confirm', async () => {
    mockApi({ [`GET ${BASE}`]: () => Response.json({ documents: [SAL, PENDING] }) })
    renderWithProviders(<MemoryView slug="alpha" />)
    const row = (await screen.findByText('SAL-Aurora-2026-11-04.md')).closest('tr') as HTMLElement
    expect(within(row).getByLabelText(/Tipo SAL/)).toHaveValue('status_report')
    expect(within(row).getByText('da nome del file')).toBeInTheDocument()
    expect(within(row).getByText('da confermare')).toBeInTheDocument()
    expect(within(row).getByText(/2 KB · Paola Prova · 3 brani/)).toBeInTheDocument()
    const pending = screen.getByText('nota.txt').closest('tr') as HTMLElement
    expect(within(pending).getByText('In elaborazione')).toBeInTheDocument()
    expect(within(pending).getByLabelText(/Tipo nota.txt/)).toBeDisabled()
  })

  it('says when there is nothing yet', async () => {
    mockApi({ [`GET ${BASE}`]: () => Response.json({ documents: [] }) })
    renderWithProviders(<MemoryView slug="alpha" />)
    expect(await screen.findByText(/Nessun documento/)).toBeInTheDocument()
  })

  it('uploads picked files as multipart with the CSRF token', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ documents: [] }),
      [`POST ${BASE}`]: () => Response.json(SAL, { status: 201 }),
    })
    renderWithProviders(<MemoryView slug="alpha" />)
    const file = new File(['Stato'], 'SAL.md', { type: 'text/markdown' })
    await userEvent.upload(screen.getByTestId('file-input'), file)
    expect(await screen.findByText('SAL.md caricato')).toBeInTheDocument()
    const post = calls.find((call) => call.key === `POST ${BASE}`)
    expect(post?.init.body).toBeInstanceOf(FormData)
    const headers = post?.init.headers as Record<string, string> | undefined
    expect(headers?.['x-csrf-token']).toBe('csrf-1')
  })

  it('explains a refused upload, dropped on the panel', async () => {
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ documents: [] }),
      [`POST ${BASE}`]: () => Response.json({ error: 'conflict' }, { status: 409 }),
    })
    renderWithProviders(<MemoryView slug="alpha" />)
    const zone = await screen.findByRole('region', { name: /Trascina qui/ })
    const file = new File(['x'], 'doppio.md')
    fireEvent.dragOver(zone)
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(
      await screen.findByText('doppio.md: Il progetto contiene già questo file.'),
    ).toBeInTheDocument()
  })

  it('records the PM choice of audience', async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => Response.json({ documents: [SAL] }),
      [`PATCH ${BASE}/d-1`]: () => Response.json({ ...SAL, audience: 'client' }),
    })
    renderWithProviders(<MemoryView slug="alpha" />)
    await userEvent.selectOptions(await screen.findByLabelText(/Destinatari SAL/), 'client')
    await waitFor(() => expect(calls.some((c) => c.key === `PATCH ${BASE}/d-1`)).toBe(true))
    const patch = calls.find((c) => c.key === `PATCH ${BASE}/d-1`)
    expect(JSON.parse(String(patch?.init.body))).toEqual({ audience: 'client' })
  })

  it('shows the extracted text with the place of each passage', async () => {
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ documents: [SAL] }),
      [`GET ${BASE}/d-1`]: () =>
        Response.json({
          document: SAL,
          chunks: [
            { locator: { kind: 'line', from: 1, to: 2 }, text: 'Stato avanzamento lavori' },
            { locator: { kind: 'page', page: 3 }, text: 'Budget' },
            { locator: { kind: 'cell', sheet: 'Costi', ref: 'B7' }, text: '480.000 €' },
          ],
        }),
    })
    renderWithProviders(<MemoryView slug="alpha" />)
    await userEvent.click(await screen.findByRole('button', { name: /Vedi testo SAL/ }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Stato avanzamento lavori')).toBeInTheDocument()
    expect(within(dialog).getByText('righe 1–2')).toBeInTheDocument()
    expect(within(dialog).getByText('pag. 3')).toBeInTheDocument()
    expect(within(dialog).getByText('Costi!B7')).toBeInTheDocument()
  })

  it('deletes after confirmation and explains a refusal', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ documents: [SAL] }),
      [`DELETE ${BASE}/d-1`]: () => Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    renderWithProviders(<MemoryView slug="alpha" />)
    await userEvent.click(await screen.findByRole('button', { name: /Elimina SAL/ }))
    expect(confirm).toHaveBeenCalled()
    expect(await screen.findByText(/Può eliminarlo solo chi l'ha caricato/)).toBeInTheDocument()
    confirm.mockRestore()
  })
})
