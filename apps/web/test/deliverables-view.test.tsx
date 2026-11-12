import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { DeliverablesView } from '@/components/deliverables/DeliverablesView'
import { parameterValues } from '@/components/deliverables/RunForm'
import type { DocumentDto, RecipeDto, RunDto, RunViewDto } from '@/lib/api-types'
import { mockApi, renderWithProviders } from './support/render'
import { resetRouter } from './support/router'

const RUNS = '/api/projects/alpha/runs'

const MAIL: RecipeDto = {
  slug: 'mail-cliente',
  version: '1.0.0',
  title: 'Mail al cliente',
  purpose: 'Prepara la bozza di una mail al cliente.',
  audience: 'client',
  formats: ['md'],
  parameters: [
    {
      id: 'communication_type',
      type: 'choice',
      label: 'Tipo di comunicazione',
      required: true,
      options: [
        { value: 'update', label: 'Aggiornamento' },
        { value: 'escalation', label: 'Escalation' },
      ],
    },
    {
      id: 'request',
      type: 'text',
      label: 'Cosa si chiede',
      help: 'Una sola richiesta.',
      required: true,
      maxLength: 500,
    },
    { id: 'request_due', type: 'date', label: 'Entro quando', required: true },
  ],
}

const ALL_KINDS: RecipeDto['parameters'] = [
  { id: 'period', type: 'period', label: 'Periodo', required: true },
  { id: 'total', type: 'number', label: 'Totale', required: false },
  {
    id: 'order',
    type: 'evidence_selection',
    label: 'Ordine',
    required: true,
    documentKinds: ['purchase_order'],
  },
  { id: 'invoices', type: 'evidence_selection', label: 'Fatture', required: false, multiple: true },
  {
    id: 'positions',
    type: 'rows',
    label: 'Posizioni',
    required: true,
    columns: [
      { id: 'item', label: 'Descrizione', kind: 'text' },
      { id: 'amount', label: 'Importo', kind: 'number' },
    ],
  },
  { id: 'items', type: 'work_item_selection', label: 'Attività', required: false },
]

const DOCUMENTS: DocumentDto[] = [
  {
    id: 'd-order',
    fileName: 'Ordine-OA-26-464.md',
    mediaType: 'text/markdown',
    sizeBytes: 10,
    status: 'ready',
    kind: 'purchase_order',
    audience: 'client',
    audienceSource: 'pm',
    documentDate: '2026-03-02T00:00:00.000Z',
    dateSource: 'file_name',
    uncertain: [],
    warnings: [],
    chunkCount: 1,
    uploadedBy: 'u-paola',
    uploaderName: 'Paola Prova',
    uploadedAt: '2026-11-11T10:00:00.000Z',
    sourceName: null,
    originAt: null,
  },
]
const INVOICE: DocumentDto = {
  ...(DOCUMENTS[0] as DocumentDto),
  id: 'd-invoice',
  fileName: 'Fattura-1.md',
  kind: 'invoice',
}

const run = (over: Partial<RunDto> = {}): RunDto => ({
  id: 'r-1',
  recipeSlug: 'mail-cliente',
  recipeTitle: 'Mail al cliente',
  status: 'ready',
  phase: null,
  errorCode: null,
  revisionError: null,
  approval: null,
  approvalError: null,
  requestedBy: 'u-paola',
  createdAt: '2026-11-12T09:00:00.000Z',
  approvedAt: null,
  ...over,
})

const view = (over: Partial<RunViewDto> = {}): RunViewDto => ({
  run: run(),
  revision: 1,
  approvable: false,
  summary: { checks: 173, open: 2, accepted: 0, warnings: 1 },
  findings: [
    {
      code: 'without_source',
      class: 'data',
      kind: 'anomaly',
      refKey: 'ref-1',
      slot: 'subject_line',
      status: 'open',
      acceptable: false,
      text: 'Un testo riporta dati senza una fonte verificata.',
      place: { section: 'Oggetto' },
      excerpt: 'Il totale è 123.456 euro.',
    },
    {
      code: 'recipe_check_not_evaluable',
      class: 'data',
      kind: 'anomaly',
      refKey: 'ref-2',
      slot: null,
      status: 'open',
      acceptable: true,
      text: 'Il controllo «chiusura senza residui» non si può fare.',
      place: {},
      excerpt: null,
    },
    {
      code: 'old_snapshot',
      class: 'form',
      kind: 'warning',
      refKey: 'ref-3',
      slot: null,
      status: null,
      acceptable: false,
      text: 'I dati sono stati letti qualche ora fa.',
      place: {},
      excerpt: null,
    },
  ],
  files: [],
  document: {
    title: 'Mail al cliente',
    sections: [
      {
        id: 'body',
        title: 'Testo della mail',
        blocks: [
          { id: 'greeting', kind: 'static', text: 'Buongiorno,' },
          {
            id: 'action',
            kind: 'value',
            label: 'Azione richiesta',
            cell: { text: 'Confermare la data', sources: [1] },
          },
          { id: 'empty', kind: 'value', label: 'Residuo', cell: { text: null } },
          {
            id: 'context',
            kind: 'text',
            title: 'Contesto',
            segments: [{ text: 'Il collaudo è previsto a novembre.', sources: [2] }],
          },
          {
            id: 'positions',
            kind: 'table',
            title: 'Posizioni',
            columns: [{ id: 'item', title: 'Descrizione' }],
            rows: [{ key: '1', cells: [{ text: 'Analisi e disegno' }] }],
          },
          {
            id: 'documents',
            kind: 'list',
            columns: [{ id: 'title', title: 'Documento' }],
            items: [],
          },
        ],
      },
    ],
    sourceNotes: [{ n: 1, label: 'Indicato da te: Cosa si chiede' }],
  },
  ...over,
})

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string)

describe('DeliverablesView', () => {
  beforeEach(() => resetRouter('/projects/alpha/deliverables'))

  it('offers the recipes, fills the form of one and starts a run', async () => {
    const calls = mockApi({
      'GET /api/recipes': () => Response.json({ recipes: [MAIL] }),
      [`GET ${RUNS}`]: () => Response.json({ runs: [] }),
      'GET /api/projects/alpha/documents': () => Response.json({ documents: [] }),
      [`POST ${RUNS}`]: () => Response.json(run({ status: 'queued' }), { status: 201 }),
      [`GET ${RUNS}/r-1`]: () =>
        Response.json(
          view({
            run: run({ status: 'running', phase: 'writing' }),
            revision: 0,
            document: null,
            findings: [],
            summary: null,
          }),
        ),
    })
    renderWithProviders(<DeliverablesView slug="alpha" />)
    expect(await screen.findByText('Nessun documento ancora.')).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: /Mail al cliente/ }))
    expect(screen.getByText('Una sola richiesta.')).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText('Tipo di comunicazione'), 'escalation')
    await userEvent.type(screen.getByLabelText('Cosa si chiede'), 'Confermare la data')
    await userEvent.type(screen.getByLabelText('Entro quando'), '2026-11-20')
    await userEvent.click(screen.getByRole('button', { name: 'Prepara il documento' }))
    await waitFor(() => expect(calls.some((call) => call.key === `POST ${RUNS}`)).toBe(true))
    expect(bodyOf(calls.find((call) => call.key === `POST ${RUNS}`)?.init as RequestInit)).toEqual({
      recipeSlug: 'mail-cliente',
      parameters: {
        communication_type: { type: 'choice', value: 'escalation' },
        request: { type: 'text', value: 'Confermare la data' },
        request_due: { type: 'date', day: '2026-11-20' },
      },
    })
    expect(await screen.findByText('Scrivo i testi…')).toBeTruthy()
  })

  it('shows the draft with its findings and lets the PM ask a change, accept and approve', async () => {
    let current = view()
    const calls = mockApi({
      'GET /api/recipes': () => Response.json({ recipes: [MAIL] }),
      [`GET ${RUNS}`]: () => Response.json({ runs: [current.run] }),
      'GET /api/projects/alpha/documents': () => Response.json({ documents: [] }),
      [`GET ${RUNS}/r-1`]: () => Response.json(current),
      [`POST ${RUNS}/r-1/changes`]: () => new Response(null, { status: 202 }),
      [`POST ${RUNS}/r-1/acceptances`]: (init) => {
        if (bodyOf(init).reason.length < 20)
          return Response.json({ error: 'invalid' }, { status: 400 })
        current = view({
          approvable: true,
          summary: { checks: 173, open: 0, accepted: 1, warnings: 1 },
          findings: [
            { ...(view().findings[1] as RunViewDto['findings'][number]), status: 'accepted' },
          ],
        })
        return Response.json(current)
      },
      [`POST ${RUNS}/r-1/approval`]: () => {
        current = view({ run: run({ approval: 'approving' }), findings: [], approvable: false })
        return new Response(null, { status: 202 })
      },
    })
    renderWithProviders(<DeliverablesView slug="alpha" />)
    await userEvent.click(await screen.findByRole('button', { name: /Da rivedere/ }))
    expect(
      await screen.findByText('173 controlli · 2 anomalie aperte · nessuna accettata'),
    ).toBeTruthy()
    expect(screen.getByText('Da rivedere · revisione 1')).toBeTruthy()

    // The document: fixed text, values with their notes, written text, table, empty list, sources.
    expect(screen.getByText('Buongiorno,')).toBeTruthy()
    expect(screen.getByText('Confermare la data')).toBeTruthy()
    expect(screen.getByText('Il collaudo è previsto a novembre.')).toBeTruthy()
    expect(screen.getByText('Analisi e disegno')).toBeTruthy()
    expect(screen.getByText('Nessuna riga.')).toBeTruthy()
    expect(screen.getByText('[1] Indicato da te: Cosa si chiede')).toBeTruthy()

    const approve = screen.getByRole('button', { name: 'Approva' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    const anomalies = screen.getByRole('region', { name: 'Anomalie' })
    const [unsupported, notEvaluable] = within(anomalies).getAllByRole('listitem')
    expect(
      within(unsupported as HTMLElement).getByText('Anomalia · dati · Oggetto · aperta'),
    ).toBeTruthy()
    expect(
      within(unsupported as HTMLElement).queryByRole('button', {
        name: 'Accetta con questa motivazione',
      }),
    ).toBeNull()
    await userEvent.type(within(unsupported as HTMLElement).getByRole('textbox'), 'Togli la cifra')
    await userEvent.click(
      within(unsupported as HTMLElement).getByRole('button', { name: 'Chiedi modifica' }),
    )
    await waitFor(() =>
      expect(calls.some((call) => call.key === `POST ${RUNS}/r-1/changes`)).toBe(true),
    )
    expect(
      bodyOf(calls.find((call) => call.key === `POST ${RUNS}/r-1/changes`)?.init as RequestInit),
    ).toEqual({
      slots: ['subject_line'],
      request: 'Togli la cifra',
    })

    const warnings = screen.getByRole('region', { name: 'Avvisi' })
    expect(within(warnings).queryByRole('textbox')).toBeNull()
    await userEvent.type(within(notEvaluable as HTMLElement).getByRole('textbox'), 'ok')
    await userEvent.click(
      within(notEvaluable as HTMLElement).getByRole('button', {
        name: 'Accetta con questa motivazione',
      }),
    )
    expect(await screen.findByText(/Serve una motivazione di almeno una frase/)).toBeTruthy()
    await userEvent.type(
      within(notEvaluable as HTMLElement).getByRole('textbox'),
      ' Il DWSI non è collegato al progetto.',
    )
    await userEvent.click(
      within(notEvaluable as HTMLElement).getByRole('button', {
        name: 'Accetta con questa motivazione',
      }),
    )
    expect(
      await screen.findByText('173 controlli · nessuna anomalia aperta · 1 accettata'),
    ).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Approva' }))
    expect(await screen.findByText('Approvato: preparo i file… · revisione 1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approva' })).toBeNull()
  })

  it('shows the files of an approved run and what went wrong when something did', async () => {
    const approved = view({
      run: run({ approval: 'approved', approvedAt: '2026-11-12T10:00:00.000Z' }),
      findings: [],
      files: [
        {
          id: 'f-1',
          audience: 'client',
          format: 'md',
          fileName: 'mail-cliente.md',
          sizeBytes: 900,
        },
      ],
    })
    const failed = view({
      run: run({
        id: 'r-2',
        status: 'failed',
        errorCode: 'recipe_parameter_invalid',
        revisionError: 'revision_anomaly_added',
        approvalError: 'renderer_unavailable',
      }),
      revision: 0,
      document: null,
      findings: [],
      summary: null,
    })
    mockApi({
      'GET /api/recipes': () => Response.json({ recipes: [] }),
      [`GET ${RUNS}`]: () => Response.json({ runs: [approved.run, failed.run] }),
      'GET /api/projects/alpha/documents': () => Response.json({ documents: [] }),
      [`GET ${RUNS}/r-1`]: () => Response.json(approved),
      [`GET ${RUNS}/r-2`]: () => Response.json(failed),
    })
    renderWithProviders(<DeliverablesView slug="alpha" />)
    expect(await screen.findByText(/Scegli una ricetta/)).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: /Approvato/ }))
    const link = (await screen.findByRole('link', { name: 'mail-cliente.md' })) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(`${RUNS}/r-1/files/f-1`)
    expect(screen.getByText('(per il cliente)')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Non riuscito/ }))
    expect(
      await screen.findByText('La preparazione non è riuscita (recipe_parameter_invalid).'),
    ).toBeTruthy()
    expect(screen.getByText(/non è stata tenuta \(revision_anomaly_added\)/)).toBeTruthy()
    expect(screen.getByText(/I file non sono stati prodotti \(renderer_unavailable\)/)).toBeTruthy()
  })

  it('builds every kind of field a recipe declares', async () => {
    const recipe: RecipeDto = {
      ...MAIL,
      slug: 'sal',
      title: 'SAL economico',
      parameters: ALL_KINDS,
    }
    const calls = mockApi({
      'GET /api/recipes': () => Response.json({ recipes: [recipe] }),
      [`GET ${RUNS}`]: () => Response.json({ runs: [] }),
      'GET /api/projects/alpha/documents': () =>
        Response.json({ documents: [...DOCUMENTS, INVOICE] }),
      [`POST ${RUNS}`]: () => Response.json(run({ status: 'queued' }), { status: 201 }),
      [`GET ${RUNS}/r-1`]: () => Response.json(view()),
    })
    renderWithProviders(<DeliverablesView slug="alpha" />)
    await userEvent.click(await screen.findByRole('button', { name: /SAL economico/ }))
    await userEvent.type(screen.getByLabelText('Periodo: dal'), '2026-10-01')
    await userEvent.type(screen.getByLabelText('Periodo: al'), '2026-10-31')
    await userEvent.type(screen.getByLabelText('Totale'), '570000,5')
    // Only the documents of the kind the recipe asks for are offered.
    const order = screen.getByLabelText('Ordine') as HTMLSelectElement
    expect([...order.options].map((option) => option.textContent)).toEqual([
      '—',
      'Ordine-OA-26-464.md',
    ])
    await userEvent.selectOptions(order, 'd-order')
    await userEvent.selectOptions(screen.getByLabelText('Fatture'), ['d-invoice'])
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi riga' }))
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi riga' }))
    await userEvent.click(screen.getByRole('button', { name: "Togli l'ultima riga" }))
    await userEvent.type(screen.getByLabelText('Posizioni 1: Descrizione'), 'Analisi')
    await userEvent.type(screen.getByLabelText('Posizioni 1: Importo'), '150000')
    expect(screen.getByText('Questo parametro non si può ancora compilare da qui.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Prepara il documento' }))
    await waitFor(() => expect(calls.some((call) => call.key === `POST ${RUNS}`)).toBe(true))
    expect(
      bodyOf(calls.find((call) => call.key === `POST ${RUNS}`)?.init as RequestInit).parameters,
    ).toEqual({
      period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
      total: { type: 'number', value: 570000.5 },
      order: { type: 'evidence_selection', evidenceIds: ['d-order'] },
      invoices: { type: 'evidence_selection', evidenceIds: ['d-invoice'] },
      positions: { type: 'rows', rows: [{ item: 'Analisi', amount: 150000 }] },
    })
    // A form can be left without starting anything.
    await userEvent.click(await screen.findByRole('button', { name: /SAL economico/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('button', { name: 'Prepara il documento' })).toBeNull()
  })

  it('leaves out what was not filled in', () => {
    expect(
      parameterValues(ALL_KINDS, {
        period: { from: '2026-10-01', to: '' },
        total: ' ',
        order: [],
        positions: [],
      }),
    ).toEqual({})
  })
})
