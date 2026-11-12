import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskView } from '@/components/ask/AskView'
import type { AnswerDto, AnswerSourceDto, QuestionDto } from '@/lib/api-types'
import { mockApi, renderWithProviders } from './support/render'
import { resetRouter } from './support/router'

const BASE = '/api/projects/alpha/questions'

/** The browser's event stream, driven by the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  readonly url: string
  closed = false
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, (event: { data: string }) => void>()
  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
  }
  addEventListener(name: string, listener: (event: { data: string }) => void) {
    this.listeners.set(name, listener)
  }
  emit(phase: string) {
    this.listeners.get('phase')?.({ data: JSON.stringify({ phase, error: null }) })
  }
  close() {
    this.closed = true
  }
}

const source = (over: Partial<AnswerSourceDto> = {}): AnswerSourceDto => ({
  ref: { evidenceId: 'e-1', locator: { kind: 'page', page: 2 } } as AnswerSourceDto['ref'],
  verified: true,
  reason: null,
  title: 'SAL-Borea.md',
  sourceDate: '2026-11-04T00:00:00.000Z',
  dateSource: 'file_name',
  pmAsserted: false,
  contested: false,
  futureDate: false,
  freshnessPolicy: 'document',
  superseded: false,
  freshness: { level: 'dated', ageHours: 200 },
  ...over,
})

const segment = (over: Partial<AnswerDto['segments'][number]>): AnswerDto['segments'][number] => ({
  text: 'Il budget complessivo è di 890.000 €.',
  originalText: 'Il budget complessivo è di 890.000 €.',
  nature: 'fact',
  sources: [source()],
  inScope: true,
  dataKinds: [],
  mentionsKnownName: false,
  mixedScript: false,
  withoutSource: false,
  freshness: 'dated',
  warning: 'superseded',
  contested: true,
  numbersSuspended: false,
  suspendedReason: null,
  ...over,
})

const ANSWER: AnswerDto = {
  lang: 'it',
  segments: [
    segment({}),
    segment({
      text: null,
      originalText: 'Il totale è 123.456 €.',
      sources: [source({ verified: false, reason: 'numbers_not_in_source' })],
      freshness: 'unknown',
      warning: null,
      contested: false,
      suspendedReason: 'without_source',
    }),
    segment({
      text: 'Conviene chiedere conferma.',
      nature: 'suggestion',
      sources: [],
      contested: false,
    }),
  ],
  contradictions: [
    {
      subject: 'Budget complessivo',
      reason: 'I documenti riportano valori diversi.',
      originalSubject: 'Budget complessivo',
      originalReason: 'I documenti riportano valori diversi.',
      suppressed: false,
      sides: [
        {
          value: '890.000 €',
          originalValue: '890.000 €',
          source: source({ ref: { factId: 'f-1' } as AnswerSourceDto['ref'] }),
          freshness: 'dated',
          warning: null,
          suspendedReason: null,
        },
        {
          value: '950.000 €',
          originalValue: '950.000 €',
          source: source({ title: 'SAL-Borea-rev2.md', pmAsserted: true, sourceDate: null }),
          freshness: 'dated',
          warning: null,
          suspendedReason: null,
        },
      ],
      allSidesVerified: true,
      sameDocument: false,
    },
  ],
  absences: [
    {
      question: 'Chi ha approvato il budget?',
      proposal: 'Carica il verbale del comitato.',
      originalQuestion: 'Chi ha approvato il budget?',
      originalProposal: 'Carica il verbale del comitato.',
      suppressed: false,
    },
  ],
  checks: {
    total: 12,
    anomalies: 1,
    list: [
      { code: 'contested_source', index: 0 },
      { code: 'contested_source', index: 2 },
      { code: 'without_source', index: 1 },
    ],
  },
}

const question = (over: Partial<QuestionDto> = {}): QuestionDto => ({
  id: 'q-1',
  text: 'Qual è il budget?',
  phase: 'done',
  error: null,
  askedAt: '2026-11-12T09:00:00.000Z',
  answeredAt: '2026-11-12T09:00:05.000Z',
  answer: ANSWER,
  ...over,
})

describe('AskView', () => {
  beforeEach(() => {
    resetRouter('/projects/alpha/ask')
    FakeEventSource.last = null
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the latest answer: sentences, kinds, freshness, sources, contradictions, absences', async () => {
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ questions: [question()] }),
      [`GET ${BASE}/q-1`]: () => Response.json(question()),
    })
    renderWithProviders(<AskView slug="alpha" />)
    const first = (await screen.findByText('Il budget complessivo è di 890.000 €.')).closest(
      'li',
    ) as HTMLElement
    expect(within(first).getByText('Fatto')).toBeTruthy()
    expect(within(first).getByText('Datato · esiste una versione più recente')).toBeTruthy()
    expect(within(first).getByText('in contraddizione')).toBeTruthy()
    expect(within(first).getByText('SAL-Borea.md')).toBeTruthy()
    expect(within(first).getByText('· pag. 2')).toBeTruthy()

    // A suspended sentence never shows what the model wrote.
    expect(screen.queryByText(/123\.456/)).toBeNull()
    expect(screen.getByText('Frase sospesa: nessuna fonte verificata la sostiene.')).toBeTruthy()
    expect(screen.getAllByText('(i numeri non sono nella fonte)')).toHaveLength(1)
    expect(screen.getByText('Suggerimento')).toBeTruthy()

    const contradiction = screen
      .getByText('Fonti in contraddizione')
      .closest('section') as HTMLElement
    expect(within(contradiction).getByText('950.000 €')).toBeTruthy()
    expect(within(contradiction).getByText('· fatto')).toBeTruthy()
    expect(within(contradiction).getByText('· data non nota')).toBeTruthy()
    expect(within(contradiction).getByText('· indicato da te')).toBeTruthy()
    expect(screen.getByText('Carica il verbale del comitato.')).toBeTruthy()
    expect(screen.getByText('12 controlli · 1 anomalia')).toBeTruthy()
    const anomalies = screen.getByRole('list', { name: 'Anomalie rilevate dai controlli' })
    expect(within(anomalies).getByText("fonte in contraddizione con un'altra (2)")).toBeTruthy()
    expect(within(anomalies).getByText('frase senza una fonte verificata')).toBeTruthy()
    // An answered question opens no event stream.
    expect(FakeEventSource.last).toBeNull()
  })

  it('asks a question and follows its progress until the answer arrives', async () => {
    const pending = question({ id: 'q-2', text: 'Quali rischi?', phase: 'queued', answer: null })
    let answered = false
    const calls = mockApi({
      [`GET ${BASE}`]: () =>
        Response.json({ questions: answered ? [question({ id: 'q-2' })] : [] }),
      [`POST ${BASE}`]: () => Response.json(pending, { status: 201 }),
      [`GET ${BASE}/q-2`]: () =>
        Response.json(answered ? question({ id: 'q-2', text: 'Quali rischi?' }) : pending),
    })
    renderWithProviders(<AskView slug="alpha" />)
    expect(await screen.findByText('Nessuna domanda ancora.')).toBeTruthy()
    const send = screen.getByRole('button', { name: 'Chiedi' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('La tua domanda'), 'Quali rischi?')
    await userEvent.click(send)
    expect(await screen.findByText('In coda…')).toBeTruthy()
    const post = calls.find((call) => call.key === `POST ${BASE}`)
    expect(JSON.parse(post?.init.body as string)).toEqual({ text: 'Quali rischi?' })

    const stream = FakeEventSource.last as FakeEventSource
    expect(stream.url).toBe(`${BASE}/q-2/events`)
    act(() => stream.emit('reading'))
    expect(await screen.findByText('Sto leggendo documenti e fatti del progetto…')).toBeTruthy()
    act(() => stream.emit('checking'))
    expect(await screen.findByText('Sto verificando ogni frase sulle fonti…')).toBeTruthy()
    answered = true
    act(() => stream.emit('done'))
    expect(await screen.findByText('12 controlli · 1 anomalia')).toBeTruthy()
    expect(stream.closed).toBe(true)
  })

  it('explains a failed question and reads again when the stream drops', async () => {
    const failed = question({ phase: 'failed', error: 'model_unavailable', answer: null })
    const other = question({ id: 'q-9', text: 'Altra?', phase: 'reading', answer: null })
    let dropped = false
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ questions: [failed, other] }),
      [`GET ${BASE}/q-1`]: () => Response.json(failed),
      [`GET ${BASE}/q-9`]: () =>
        Response.json(dropped ? { ...other, phase: 'failed', error: 'boh' } : other),
      [`DELETE ${BASE}/q-1`]: () => new Response(null, { status: 204 }),
    })
    renderWithProviders(<AskView slug="alpha" />)
    expect(
      await screen.findByText('Il modello non è raggiungibile. Riprova fra poco.'),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Altra\?/ }))
    await waitFor(() => expect(FakeEventSource.last?.url).toBe(`${BASE}/q-9/events`))
    dropped = true
    act(() => FakeEventSource.last?.onerror?.())
    expect(await screen.findByText('La risposta non è riuscita. Riprova.')).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: 'Rimuovi dallo storico: Qual è il budget?' }),
    )
  })

  it('says when the sources give no answer', async () => {
    const empty = question({
      answer: {
        ...ANSWER,
        segments: [],
        contradictions: [],
        absences: [],
        checks: { total: 1, anomalies: 0, list: [] },
      },
    })
    mockApi({
      [`GET ${BASE}`]: () => Response.json({ questions: [empty] }),
      [`GET ${BASE}/q-1`]: () => Response.json(empty),
    })
    renderWithProviders(<AskView slug="alpha" />)
    expect(await screen.findByText('Nessuna risposta dalle fonti disponibili.')).toBeTruthy()
    expect(screen.getByText('1 controllo · nessuna anomalia')).toBeTruthy()
  })
})
