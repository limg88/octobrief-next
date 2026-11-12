import { randomBytes } from 'node:crypto'
import { EMBEDDING_DIMENSIONS, EmbeddingResponseError } from '@octobrief/application'
import { newId, type ProjectId } from '@octobrief/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS, llmApiRunner } from '../src/model/llm-api-client.ts'
import { type FakeLlmApiServer, startFakeLlmApi } from './support/fake-llm-api-server.ts'
import { unitVector } from './support/vectors.ts'

const TOKEN = `sk-${randomBytes(16).toString('hex')}`
const projectId = newId<ProjectId>()
const encoder = { model: 'ollama/embeddings', digest: '790764642607', backend: 'ollama' }

const embeddings = (vectors: number[][], indexes = vectors.map((_, i) => i)) => ({
  object: 'list',
  model: 'ollama/embeddings',
  data: vectors.map((embedding, i) => ({ object: 'embedding', index: indexes[i], embedding })),
  usage: { prompt_tokens: 9, total_tokens: 9 },
})

let server: FakeLlmApiServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

async function setup(script: Parameters<typeof startFakeLlmApi>[0], timeoutMs?: number) {
  server = await startFakeLlmApi(script)
  const runner = llmApiRunner({
    baseUrl: server.url,
    token: TOKEN,
    model: 'chat-model',
    backend: 'llm-api',
    embedding: encoder,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  const embed = runner.embed
  if (!embed) throw new Error('no embed')
  return {
    server,
    embed: (texts: string[], signal?: AbortSignal) =>
      embed.call(runner, { texts, context: { projectId } }, signal),
  }
}

describe('llm-api embeddings contract', () => {
  it('posts the texts to /v1/embeddings as floats of 1024 dimensions and returns them in order', async () => {
    const a = unitVector(1)
    const b = unitVector(2)
    const { server, embed } = await setup([{ status: 200, json: embeddings([b, a], [1, 0]) }])
    const res = await embed(['primo', 'secondo'])
    expect(res.vectors).toEqual([a, b])
    expect(res.encoder).toEqual({ model: 'ollama/embeddings', digest: '790764642607' })
    expect(res.backend).toBe('ollama')
    expect(res.usage).toEqual({ inputTokens: 9 })
    const sent = server.requests[0]
    expect(sent?.method).toBe('POST')
    expect(sent?.path).toBe('/v1/embeddings')
    expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(sent?.headers['x-octobrief-project']).toBe(projectId)
    expect(sent?.body).toEqual({
      model: 'ollama/embeddings',
      input: ['primo', 'secondo'],
      encoding_format: 'float',
      dimensions: EMBEDDING_DIMENSIONS,
    })
  })

  it('has no embed without an encoder', () => {
    const runner = llmApiRunner({ baseUrl: 'http://x', token: TOKEN, model: 'm', backend: 'b' })
    expect(runner.embed).toBeUndefined()
    expect(runner.embedding).toBeUndefined()
  })

  it('waits 80 seconds by default, under the 90 of the gateway', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(80_000)
  })

  it.each([
    ['no text', []],
    ['more than 64 texts', Array.from({ length: 65 }, () => 'x')],
    ['an empty text', ['a', '']],
  ])('refuses %s before the network', async (_name, texts) => {
    const { server, embed } = await setup([])
    await expect(embed(texts)).rejects.toMatchObject({ name: 'ModelError', kind: 'rejected' })
    expect(server.requests).toHaveLength(0)
  })

  it.each([
    ['a vector of the wrong dimension', embeddings([unitVector(1).slice(0, 768)]), 'dimension'],
    [
      'a vector that is not of unit length',
      embeddings([unitVector(1).map((x) => x * 2)]),
      'not_normalized',
    ],
    ['a zero vector', embeddings([new Array(EMBEDDING_DIMENSIONS).fill(0)]), 'not_normalized'],
    ['fewer vectors than texts', embeddings([]), 'cardinality'],
    ['a repeated index', embeddings([unitVector(1), unitVector(2)], [0, 0]), 'cardinality'],
    ['an index out of range', embeddings([unitVector(1)], [3]), 'cardinality'],
  ])('rejects %s with a typed error', async (_name, json, defect) => {
    const texts = defect === 'cardinality' && json.data.length === 2 ? ['a', 'b'] : ['a']
    const { embed } = await setup([{ status: 200, json }])
    const err = await embed(texts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EmbeddingResponseError)
    expect(err).toMatchObject({ kind: 'bad_response', defect })
  })

  it('rejects a non-finite number with a typed error', async () => {
    const v = unitVector(1)
    const body = JSON.stringify(embeddings([v])).replace(/^(.*?"embedding":\[)[^,]+/, '$11e999')
    const { embed } = await setup([{ status: 200, body }])
    const err = await embed(['a']).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'EmbeddingResponseError', defect: 'not_finite' })
  })

  it.each([
    [503, 'unavailable'],
    [429, 'busy'],
    [400, 'rejected'],
    [403, 'rejected'],
  ])('maps HTTP %i to %s, without echoing the body', async (status, kind) => {
    const { embed } = await setup([{ status, body: `secret ${TOKEN} Mario Rossi` }])
    const err = (await embed(['a']).catch((e: unknown) => e)) as Error
    expect(err).toMatchObject({ name: 'ModelError', kind, status })
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain('Mario')
  })

  it('reports a body that is not an embedding list as a bad response', async () => {
    const { embed } = await setup([{ status: 200, body: 'not json' }])
    await expect(embed(['a'])).rejects.toMatchObject({ kind: 'bad_response' })
  })

  it('times out a stalled call', async () => {
    const { embed } = await setup(
      [{ status: 200, json: embeddings([unitVector(1)]), delayMs: 500 }],
      50,
    )
    await expect(embed(['a'])).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('waits for the encoder its own time, not the time of the chat model', async () => {
    server = await startFakeLlmApi([
      { status: 200, json: embeddings([unitVector(1)]), delayMs: 150 },
      { status: 200, json: embeddings([unitVector(1)]), delayMs: 150 },
    ])
    const runner = (embeddingTimeoutMs: number) =>
      llmApiRunner({
        baseUrl: (server as FakeLlmApiServer).url,
        token: TOKEN,
        model: 'chat-model',
        backend: 'llm-api',
        embedding: encoder,
        timeoutMs: 5_000,
        embeddingTimeoutMs,
      })
    const call = (r: ReturnType<typeof runner>) =>
      r.embed?.call(r, { texts: ['a'], context: { projectId } })
    await expect(call(runner(50))).rejects.toMatchObject({ kind: 'timeout' })
    await expect(call(runner(5_000))).resolves.toMatchObject({ backend: 'ollama' })
  })

  it('never waits past the deadline of its job', async () => {
    server = await startFakeLlmApi([
      { status: 200, json: embeddings([unitVector(1)]), delayMs: 300 },
    ])
    const r = llmApiRunner({
      baseUrl: server.url,
      token: TOKEN,
      model: 'chat-model',
      backend: 'llm-api',
      embedding: encoder,
      timeoutMs: 5_000,
      deadlineAt: Date.now() + 50,
    })
    await expect(r.embed?.call(r, { texts: ['a'], context: { projectId } })).rejects.toMatchObject({
      kind: 'timeout',
    })
    const past = llmApiRunner({
      baseUrl: server.url,
      token: TOKEN,
      model: 'chat-model',
      backend: 'llm-api',
      embedding: encoder,
      deadlineAt: Date.now() - 1,
    })
    const before = server.requests.length
    await expect(
      past.embed?.call(past, { texts: ['a'], context: { projectId } }),
    ).rejects.toMatchObject({ kind: 'timeout' })
    expect(server.requests.length).toBe(before)
  })
})
