import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingResponseError,
  ModelError,
  type ModelRequest,
} from '@octobrief/application'
import { newId, type ProjectId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { loadWorkerConfig, type ModelConfig } from '../src/config.ts'
import {
  configuredBackends,
  createModelRunner,
  modelAdapter,
} from '../src/model/create-model-runner.ts'
import { fakeEmbedding, fakeRunner } from '../src/model/fake-runner.ts'
import { ollamaEmbedder } from '../src/model/ollama-embedder.ts'

const context = { projectId: newId<ProjectId>() }
const compileRequest = (chunks: Array<{ n: number; text: string }>): ModelRequest => ({
  messages: [
    { role: 'system', content: 'compila' },
    { role: 'user', content: JSON.stringify({ documento: {}, frammenti: chunks }) },
  ],
  responseSchema: { name: 'compiled_facts', schema: {} },
  context,
})
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] as number), 0)

describe('fake model', () => {
  it('reports one fact per recognized sentence, quoting it exactly', async () => {
    const response = await fakeRunner().run(
      compileRequest([
        {
          n: 0,
          text: '# Stato avanzamento\nBudget: 120.000 euro. Oggi piove molto.\nRischio di ritardo del fornitore.',
        },
        { n: 3, text: 'La consegna è prevista a dicembre. Breve.' },
      ]),
    )
    expect(JSON.parse(response.message.content as string)).toEqual({
      facts: [
        {
          kind: 'economics',
          subject: 'Budget',
          statement: 'Budget: 120.000 euro.',
          value: '120.000 euro',
          sources: [{ n: 0, excerpt: 'Budget: 120.000 euro.' }],
        },
        {
          kind: 'risk',
          subject: 'Rischio di ritardo del fornitore.',
          statement: 'Rischio di ritardo del fornitore.',
          value: null,
          sources: [{ n: 0, excerpt: 'Rischio di ritardo del fornitore.' }],
        },
        {
          kind: 'milestone',
          subject: 'La consegna è prevista a',
          statement: 'La consegna è prevista a dicembre.',
          value: null,
          sources: [{ n: 3, excerpt: 'La consegna è prevista a dicembre.' }],
        },
      ],
    })
  })

  it('answers an empty object to a request it has no skill for', async () => {
    const response = await fakeRunner().run({ messages: [], context })
    expect(response.message.content).toBe('{}')
  })

  it('makes unit vectors that are closer for texts sharing words', async () => {
    const budget = fakeEmbedding('budget di progetto approvato')
    expect(budget).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(Math.hypot(...budget)).toBeCloseTo(1)
    expect(Math.hypot(...fakeEmbedding(''))).toBe(1)
    expect(dot(budget, fakeEmbedding('il budget approvato'))).toBeGreaterThan(
      dot(budget, fakeEmbedding('rischio fornitore')),
    )
  })

  it('writes down what it receives when asked to', async () => {
    const transcriptPath = join(mkdtempSync(join(tmpdir(), 'octobrief-fake-')), 'seen.jsonl')
    const runner = fakeRunner({ transcriptPath })
    await runner.run(compileRequest([{ n: 0, text: 'Budget: 1 euro in tutto.' }]))
    await runner.embed?.({ texts: ['uno'], context })
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['chat', 'embed'])
  })
})

describe('ollama embedder', () => {
  const vector = (first: number) => [first, ...new Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)]
  const embedder = (respond: (body: unknown) => Response | Promise<Response>) =>
    ollamaEmbedder({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'bge-m3',
      fetch: (async (_url: unknown, init?: RequestInit) =>
        respond(JSON.parse(init?.body as string))) as typeof fetch,
    })

  it('sends the texts to /api/embed and normalizes the vectors', async () => {
    let sent: unknown
    const response = await embedder((body) => {
      sent = body
      return Response.json({ embeddings: [vector(2), vector(1)], prompt_eval_count: 7 })
    }).embed({ texts: ['a', 'b'], context })
    expect(sent).toEqual({ model: 'bge-m3', input: ['a', 'b'] })
    expect(response.vectors.map((v) => v[0])).toEqual([1, 1])
    expect(response).toMatchObject({
      encoder: { model: 'bge-m3', digest: 'unpinned' },
      usage: { inputTokens: 7 },
      backend: 'ollama',
    })
  })

  it.each([
    ['cardinality', { embeddings: [] }],
    ['dimension', { embeddings: [[1, 0]] }],
    ['not_normalized', { embeddings: [vector(0)] }],
    ['not_finite', { embeddings: [vector(Number.MAX_VALUE * 10)] }],
  ])('refuses vectors that cannot be stored (%s)', async (defect, body) => {
    const call = embedder(
      () => new Response(JSON.stringify(body).replaceAll('null', '1e999')),
    ).embed({ texts: ['a'], context })
    await expect(call).rejects.toMatchObject(
      defect === 'not_finite' ? { kind: 'bad_response' } : { defect },
    )
    await expect(call).rejects.toBeInstanceOf(
      defect === 'not_finite' ? ModelError : EmbeddingResponseError,
    )
  })

  it.each([
    ['rejected', () => new Response('no', { status: 500 })],
    ['bad_response', () => new Response('not json')],
    [
      'unavailable',
      () => {
        throw new TypeError('fetch failed')
      },
    ],
    [
      'timeout',
      () => {
        throw new DOMException('too slow', 'TimeoutError')
      },
    ],
  ])('turns a failed call into a model error (%s)', async (kind, respond) => {
    await expect(embedder(respond).embed({ texts: ['a'], context })).rejects.toMatchObject({ kind })
  })
})

describe('model configuration', () => {
  const BASE = {
    DATABASE_WORKER_URL: 'postgres://w@localhost/db',
    BLOB_DIR: '/var/blobs',
    SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  }
  const GATEWAY = {
    LLM_BACKEND: 'llm-api',
    LLM_API_URL: 'https://llm.example.test',
    LLM_API_TOKEN: 'token-value',
    LLM_MODEL: 'main',
  }

  it('defaults to the fake model and encoder: nothing leaves the machine', () => {
    const { model } = loadWorkerConfig(BASE)
    expect(model).toEqual({ chat: { backend: 'fake' }, embedding: { backend: 'fake' } })
    expect(configuredBackends(model)).toEqual(['fake'])
    expect(modelAdapter(model).embedding?.backend).toBe('fake')
  })

  it('reads the gateway, a local encoder, the allowed backends and the transcript', () => {
    const { model } = loadWorkerConfig({
      ...BASE,
      ...GATEWAY,
      LLM_TIMEOUT_MS: '120000',
      EMBEDDING_BACKEND: 'ollama',
      LLM_ALLOWED_BACKENDS: 'llm-api, ollama',
      LLM_FAKE_TRANSCRIPT: '/tmp/seen.jsonl',
    })
    expect(model).toEqual({
      chat: {
        backend: 'llm-api',
        url: GATEWAY.LLM_API_URL,
        token: 'token-value',
        model: 'main',
        timeoutMs: 120000,
      },
      embedding: { backend: 'ollama', url: 'http://127.0.0.1:11434', model: 'bge-m3' },
      allowedBackends: ['llm-api', 'ollama'],
      fakeTranscriptPath: '/tmp/seen.jsonl',
    })
    expect(configuredBackends(model)).toEqual(['llm-api', 'ollama'])
    const adapter = modelAdapter(model)
    expect(adapter.backend).toBe('llm-api')
    expect(adapter.embedding).toMatchObject({ model: 'bge-m3', backend: 'ollama' })
  })

  it('pairs the gateway with its own encoder, the fake one, or none', () => {
    const adapterFor = (EMBEDDING_BACKEND: string) =>
      modelAdapter(loadWorkerConfig({ ...BASE, ...GATEWAY, EMBEDDING_BACKEND }).model)
    expect(adapterFor('llm-api').embedding).toEqual({
      model: 'bge-m3',
      digest: 'unpinned',
      backend: 'llm-api',
    })
    expect(adapterFor('fake').embedding?.backend).toBe('fake')
    expect(adapterFor('none').embed).toBeUndefined()
    expect(
      modelAdapter(loadWorkerConfig({ ...BASE, EMBEDDING_BACKEND: 'none' }).model).embed,
    ).toBeUndefined()
  })

  it('names what the gateway is missing', () => {
    expect(() => loadWorkerConfig({ ...BASE, LLM_BACKEND: 'llm-api' })).toThrow(
      'LLM_API_URL, LLM_API_TOKEN, LLM_MODEL',
    )
    expect(() => loadWorkerConfig({ ...BASE, EMBEDDING_BACKEND: 'llm-api' })).toThrow('LLM_BACKEND')
  })

  it('builds a runner that hides names and refuses a backend that is not allowed', async () => {
    const config: ModelConfig = { chat: { backend: 'fake' }, embedding: { backend: 'fake' } }
    const transcriptPath = join(mkdtempSync(join(tmpdir(), 'octobrief-fake-')), 'seen.jsonl')
    const runner = createModelRunner(
      { ...config, fakeTranscriptPath: transcriptPath },
      async () => [{ displayName: 'Mario Rossi' }],
    )
    const response = await runner.run(
      compileRequest([{ n: 0, text: 'Mario Rossi approva il budget di 10 euro.' }]),
    )
    expect(response.message.content).toContain('Mario Rossi approva')
    expect(readFileSync(transcriptPath, 'utf8')).not.toContain('Mario')

    const refused = createModelRunner({ ...config, allowedBackends: ['llm-api'] }, async () => [])
    await expect(refused.run(compileRequest([]))).rejects.toMatchObject({ kind: 'not_allowed' })
  })
})
