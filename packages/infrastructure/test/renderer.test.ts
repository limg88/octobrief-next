import { RendererUnavailable } from '@octobrief/application'
import type { RenderEnvelope } from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { loadWorkerConfig } from '../src/config.ts'
import { fakeRunner } from '../src/model/fake-runner.ts'
import { httpRenderer, readRenderAnswer } from '../src/render/http-renderer.ts'

const SHA = 'a'.repeat(64)
const envelope = { format: 'xlsx' } as unknown as RenderEnvelope
const signal = new AbortController().signal
const failed = { subject: 'file', check: 'counts', passed: false, findings: ['count_mismatch'] }

describe('renderer client', () => {
  const renderer = (respond: () => Response | Promise<Response>) =>
    httpRenderer('http://127.0.0.1:5451', { fetch: (async () => respond()) as typeof fetch })

  it('posts the envelope to /render and reads a file or a refusal', async () => {
    let sent: { url: string; body: unknown } | null = null
    const client = httpRenderer('http://127.0.0.1:5451/ignored', {
      fetch: (async (url: URL, init: RequestInit) => {
        sent = { url: String(url), body: JSON.parse(init.body as string) }
        return Response.json({ outcome: 'rendered', file: 'UEs=', sha256: SHA, checks: [] })
      }) as unknown as typeof fetch,
    })
    expect(await client.render(envelope, signal)).toEqual({
      outcome: 'rendered',
      file: 'UEs=',
      sha256: SHA,
      checks: [],
    })
    expect(sent).toEqual({ url: 'http://127.0.0.1:5451/render', body: { format: 'xlsx' } })
    const refused = renderer(() =>
      Response.json({ outcome: 'refused', checks: [failed] }, { status: 422 }),
    )
    expect(await refused.render(envelope, signal)).toMatchObject({ outcome: 'refused' })
  })

  it.each([
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['a status of a proxy', () => Response.json({ outcome: 'rendered' }, { status: 502 })],
    [
      'too large',
      () => new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } }),
    ],
  ])('takes %s as an unavailable renderer', async (_name, respond) => {
    await expect(renderer(respond).render(envelope, signal)).rejects.toBeInstanceOf(
      RendererUnavailable,
    )
  })

  it('reads an answer strictly: a file with failed checks, or a refusal without one, is no answer', () => {
    const ok = { subject: 'file', check: 'counts', passed: true, findings: [] }
    expect(
      readRenderAnswer(200, { outcome: 'rendered', file: 'UEs=', sha256: SHA, checks: [ok] }),
    ).not.toBeNull()
    const bad: Array<[number, unknown]> = [
      [200, null],
      [200, { outcome: 'rendered', file: 'not base64!', sha256: SHA, checks: [] }],
      [200, { outcome: 'rendered', file: 'UEs=', sha256: 'short', checks: [] }],
      [200, { outcome: 'rendered', file: 'UEs=', sha256: SHA, checks: [failed] }],
      [422, { outcome: 'refused', checks: [ok] }],
      [422, { outcome: 'refused', checks: [{ ...failed, check: 'unknown' }] }],
      [422, { outcome: 'refused', checks: [{ ...failed, subject: 'elsewhere' }] }],
      [422, { outcome: 'refused', checks: [{ ...failed, passed: true }] }],
      [422, { outcome: 'refused', checks: 'no' }],
      [500, { outcome: 'refused', checks: [failed] }],
    ]
    for (const [status, body] of bad) expect(readRenderAnswer(status, body)).toBeNull()
  })

  it('stops with the reason of the caller when the caller gives up', async () => {
    const controller = new AbortController()
    controller.abort(new Error('job stopped'))
    const client = renderer(() => Promise.reject(new Error('aborted')))
    await expect(client.render(envelope, controller.signal)).rejects.toThrow('job stopped')
  })
})

describe('fake model writing the texts of a recipe', () => {
  const context = { projectId: '00000000-0000-4000-8000-000000000000' as never }
  const slotRequest = (over: Record<string, unknown> = {}) => ({
    messages: [
      { role: 'system' as const, content: 'scrivi' },
      {
        role: 'user' as const,
        content: JSON.stringify({
          testo_da_scrivere: { id: 'context', nature_ammesse: ['fact'], massimo_caratteri: 120 },
          documento: {
            sezioni: [
              {
                id: 'subject',
                blocchi: [{ id: 'subject_line', tipo: 'testo_da_scrivere' }],
              },
              {
                id: 'body',
                blocchi: [
                  { id: 'context', tipo: 'testo_da_scrivere' },
                  {
                    id: 'a',
                    tipo: 'valore',
                    etichetta: 'Azione richiesta',
                    valore: { testo: 'Confermare la data.', note: [1] },
                  },
                  {
                    id: 'b',
                    tipo: 'valore',
                    etichetta: 'Entro il',
                    valore: { testo: '20/11/2026', note: [3] },
                  },
                  {
                    id: 'c',
                    tipo: 'valore',
                    etichetta: 'Residuo',
                    valore: { testo: null, note: [] },
                  },
                ],
              },
            ],
          },
          ...over,
        }),
      },
    ],
    responseSchema: { name: 'slot_text', schema: {} },
    context,
  })
  const write = async (request: ReturnType<typeof slotRequest>, inventInDrafts = false) =>
    JSON.parse((await fakeRunner({ inventInDrafts }).run(request)).message.content as string)

  it('quotes the values of the document with their notes, within the limit of the text', async () => {
    const answer = await write(slotRequest())
    expect(answer).toEqual({
      lang: 'it',
      segments: [
        { text: 'Azione richiesta: Confermare la data.', nature: 'fact', sources: [{ note: 1 }] },
        { text: 'Entro il: 20/11/2026.', nature: 'fact', sources: [{ note: 3 }] },
      ],
      absences: [],
      internalNotes: [],
    })
  })

  it('quotes other values when the PM asks for a change', async () => {
    const answer = await write(slotRequest({ richiesta_del_pm: 'Cambia il testo' }))
    expect(answer.segments[0].text).toBe('Entro il: 20/11/2026.')
  })

  it('says what is missing when the document has no value to quote', async () => {
    const answer = await write(slotRequest({ documento: { sezioni: [] } }))
    expect(answer.segments).toEqual([])
    expect(answer.absences).toHaveLength(1)
  })

  it('invents a figure only in the first text of a first draft, when asked to', async () => {
    const first = {
      testo_da_scrivere: { id: 'subject_line', nature_ammesse: ['fact'], massimo_caratteri: 120 },
    }
    const invented = await write(slotRequest(first), true)
    expect(invented.segments.at(-1)).toEqual({
      text: 'Il totale aggiornato è di 123.456 euro.',
      nature: 'fact',
      sources: [],
    })
    expect(JSON.stringify(await write(slotRequest(), true))).not.toContain('123.456')
    const again = await write(slotRequest({ ...first, richiesta_del_pm: 'Togli la cifra' }), true)
    expect(JSON.stringify(again)).not.toContain('123.456')
  })

  it('finds nothing as a reviewer and does not search for a text to write', async () => {
    const runner = fakeRunner()
    const review = await runner.run({
      messages: [],
      responseSchema: { name: 'draft_review', schema: {} },
      context,
    })
    expect(review.message.content).toBe('{"findings":[]}')
    const reading = await runner.run({
      messages: slotRequest().messages,
      tools: [{ name: 'search_knowledge', description: '', parameters: {} }],
      context,
    })
    expect(reading.finishReason).toBe('stop')
  })
})

describe('deliverables configuration', () => {
  const BASE = {
    DATABASE_WORKER_URL: 'postgres://w@localhost/db',
    BLOB_DIR: '/var/blobs',
    SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    RECIPES_DIR: '/srv/octobrief/recipes',
    TEMPLATES_DIR: '/srv/octobrief/templates',
  }

  it('reads where recipes and templates are, and the renderer when there is one', () => {
    expect(loadWorkerConfig(BASE)).toMatchObject({
      recipesDir: '/srv/octobrief/recipes',
      templatesDir: '/srv/octobrief/templates',
    })
    expect(loadWorkerConfig(BASE).rendererUrl).toBeUndefined()
    const config = loadWorkerConfig({
      ...BASE,
      RENDERER_URL: 'http://renderer:8080',
      LLM_FAKE_INVENT_IN_DRAFTS: 'true',
    })
    expect(config.rendererUrl).toBe('http://renderer:8080')
    expect(config.model.fakeInventsInDrafts).toBe(true)
    expect(() => loadWorkerConfig({ ...BASE, RECIPES_DIR: 'recipes' })).toThrow('RECIPES_DIR')
  })
})
