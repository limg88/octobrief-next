import { randomBytes } from 'node:crypto'
import {
  ModelError,
  type ModelRequest,
  modelErrorCode,
  modelErrorDetail,
} from '@octobrief/application'
import { newId, type ProjectId } from '@octobrief/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { llmApiRunner } from '../src/model/llm-api-client.ts'
import { type FakeLlmApiServer, startFakeLlmApi } from './support/fake-llm-api-server.ts'

const TOKEN = `sk-${randomBytes(16).toString('hex')}`
const projectId = newId<ProjectId>()
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ role: 'user', content: 'ciao' }],
  context: { projectId },
  ...over,
})
const completion = (message: unknown, finish = 'stop') => ({
  choices: [{ message, finish_reason: finish }],
  usage: { prompt_tokens: 7, completion_tokens: 3 },
})

let server: FakeLlmApiServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})
async function setup(script: Parameters<typeof startFakeLlmApi>[0], timeoutMs?: number) {
  server = await startFakeLlmApi(script)
  const runner = llmApiRunner({
    baseUrl: `${server.url}/`,
    token: TOKEN,
    model: 'm1',
    backend: 'llm-api',
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  return { runner, server }
}

describe('llmApiRunner contract', () => {
  it('sends tools in OpenAI format and parses tool_calls', async () => {
    const { runner, server } = await setup([
      {
        status: 200,
        json: completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"a"}' },
              },
            ],
          },
          'tool_calls',
        ),
      },
    ])
    const res = await runner.run(
      req({
        tools: [{ name: 'read', description: 'Reads', parameters: { type: 'object' } }],
        maxOutputTokens: 50,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'p', name: 'read', arguments: { x: 1 } }],
          },
          { role: 'tool', toolCallId: 'p', content: 'r' },
        ],
      }),
    )
    expect(server.requests[0]?.path).toBe('/v1/chat/completions')
    expect(server.requests[0]?.body).toEqual({
      model: 'm1',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'p', type: 'function', function: { name: 'read', arguments: '{"x":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'p', content: 'r' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read', description: 'Reads', parameters: { type: 'object' } },
        },
      ],
      max_tokens: 50,
    })
    expect(res).toEqual({
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }],
      },
      finishReason: 'tool_calls',
      usage: { inputTokens: 7, outputTokens: 3 },
      backend: 'llm-api',
    })
  })

  it('sends json_schema response format and hands the content back for the caller to judge', async () => {
    const { runner, server } = await setup([
      { status: 200, json: completion({ content: '{"a":1}' }) },
      { status: 200, json: completion({ content: 'not json' }) },
      { status: 200, json: completion({ content: null }) },
    ])
    const responseSchema = { name: 'out', schema: { type: 'object' } }
    const ok = await runner.run(req({ responseSchema }))
    expect(ok.message.content).toBe('{"a":1}')
    expect(server.requests[0]?.body).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
      },
    })
    expect((await runner.run(req({ responseSchema }))).message.content).toBe('not json')
    expect((await runner.run(req({ responseSchema }))).message.content).toBeNull()
  })

  it('refuses tools and a response format in one turn before any request', async () => {
    const { runner, server } = await setup([{ status: 200, json: completion({ content: '{}' }) }])
    await expect(
      runner.run(
        req({
          tools: [{ name: 'read', description: 'Reads', parameters: { type: 'object' } }],
          responseSchema: { name: 'out', schema: { type: 'object' } },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'rejected' })
    expect(server.requests).toHaveLength(0)
  })

  it('sends bearer token and project header on a normalized URL', async () => {
    const { runner, server } = await setup([{ status: 200, json: completion({ content: 'x' }) }])
    await runner.run(req())
    const h = server.requests[0]?.headers
    expect(h?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(h?.['x-octobrief-project']).toBe(projectId)
    expect(server.requests[0]?.path).toBe('/v1/chat/completions')
  })

  it('maps 5xx, 429, 4xx, timeout, network and malformed JSON to typed errors', async () => {
    const { runner } = await setup(
      [
        { status: 503, body: 'down' },
        { status: 429, body: 'slow down' },
        { status: 400, body: 'bad' },
        { status: 200, body: '{not json' },
        { status: 200, json: { choices: [] } },
        {
          status: 200,
          json: completion({
            content: null,
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'n', arguments: '{oops' } },
            ],
          }),
        },
        { status: 200, json: completion({ content: 'late' }), delayMs: 2000 },
      ],
      100,
    )
    const kinds: string[] = []
    for (let i = 0; i < 7; i++) {
      kinds.push(
        await runner.run(req()).then(
          () => 'ok',
          (e) => `${e.kind}:${e.status ?? ''}`,
        ),
      )
    }
    expect(kinds).toEqual([
      'unavailable:503',
      'busy:429',
      'rejected:400',
      'bad_response:',
      'bad_response:',
      'bad_response:',
      'timeout:',
    ])
    const dead = llmApiRunner({
      baseUrl: 'http://127.0.0.1:1',
      token: TOKEN,
      model: 'm',
      backend: 'b',
    })
    await expect(dead.run(req())).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it("the gateway's seat provider codes are recognised", async () => {
    const refusal = (code: string, extra: Record<string, unknown> = {}) => ({
      error: { message: 'refused', type: 'provider_error', provider_code: code, ...extra },
    })
    const cases = [
      { status: 429, code: 'rate_limit', kind: 'busy' },
      { status: 401, code: 'authentication', kind: 'rejected' },
      { status: 400, code: 'context_length_exceeded', kind: 'rejected' },
      { status: 502, code: 'max_turns', kind: 'unavailable' },
      { status: 502, code: 'overloaded', kind: 'unavailable' },
      { status: 502, code: 'connection', kind: 'unavailable' },
      { status: 502, code: 'tool_use_failed', kind: 'unavailable' },
      { status: 502, code: 'json_validate_failed', kind: 'unavailable' },
      { status: 502, code: 'unrecognized', kind: 'unavailable' },
      { status: 422, code: 'output_limit', kind: 'rejected' },
    ] as const
    const { runner } = await setup(
      cases.map((c) => ({
        status: c.status,
        json:
          c.code === 'output_limit'
            ? refusal(c.code, { code: 'output_limit_exceeded' })
            : refusal(c.code),
      })),
    )
    for (const c of cases) {
      const e = await runner.run(req()).catch((x: unknown) => x)
      expect(e, c.code).toBeInstanceOf(ModelError)
      expect(e, c.code).toMatchObject({ kind: c.kind, status: c.status, providerCode: c.code })
      expect(modelErrorCode(e as ModelError)).toBe(`model_${c.code}`)
    }
  })

  it("the seat's budget refusal without a provider code is the output limit", async () => {
    // The gateway's own budget check: 422 with `code` only, no `provider_code`.
    const { runner } = await setup([
      {
        status: 422,
        json: {
          error: {
            message: 'Output incompleto o oltre il limite richiesto',
            type: 'output_limit_exceeded',
            code: 'output_limit_exceeded',
            param: null,
          },
        },
      },
    ])
    const e = (await runner.run(req()).catch((x: unknown) => x)) as ModelError
    expect(e).toMatchObject({
      kind: 'rejected',
      status: 422,
      providerCode: 'output_limit',
      gatewayCode: 'output_limit_exceeded',
    })
    expect(modelErrorCode(e)).toBe('model_output_limit')
    expect(modelErrorDetail(e)).toBe('http 422, output_limit_exceeded')
  })

  it("a refusal keeps the HTTP status and the gateway's code, never its words", async () => {
    const { runner } = await setup([
      { status: 400, json: { error: { message: 'bad schema', code: 'invalid_request_error' } } },
      { status: 409, json: { error: { message: 'x', code: 'Not A Code: leaked text' } } },
      { status: 403, body: 'not json at all' },
      {
        status: 502,
        json: {
          error: { code: 'structured_output_invalid', provider_code: 'json_validate_failed' },
        },
      },
    ])
    const errors: ModelError[] = []
    for (let i = 0; i < 4; i++)
      errors.push((await runner.run(req()).catch((x: unknown) => x)) as ModelError)
    expect(errors.map((e) => [e.kind, e.status, e.gatewayCode, e.providerCode])).toEqual([
      ['rejected', 400, 'invalid_request_error', undefined],
      ['rejected', 409, undefined, undefined],
      ['rejected', 403, undefined, undefined],
      ['unavailable', 502, 'structured_output_invalid', 'json_validate_failed'],
    ])
    expect(errors.map(modelErrorCode)).toEqual([
      'model_rejected',
      'model_rejected',
      'model_rejected',
      'model_json_validate_failed',
    ])
    expect(errors.map(modelErrorDetail)).toEqual([
      'http 400, invalid_request_error',
      'http 409',
      'http 403',
      'http 502, structured_output_invalid',
    ])
  })

  it("the gateway's code of an answer off its schema is a JSON validation failure", async () => {
    const { runner } = await setup([
      { status: 502, json: { error: { message: 'x', code: 'structured_output_invalid' } } },
    ])
    const e = (await runner.run(req()).catch((x: unknown) => x)) as ModelError
    expect(e).toMatchObject({
      kind: 'unavailable',
      status: 502,
      providerCode: 'json_validate_failed',
    })
    expect(modelErrorCode(e)).toBe('model_json_validate_failed')
    expect(modelErrorDetail(e)).toBe('http 502, structured_output_invalid')
  })

  it('a refusal by finish reason or before the network has no HTTP detail', async () => {
    const { runner } = await setup([
      { status: 200, json: completion({ content: 'x' }, 'content_filter') },
    ])
    const filtered = (await runner.run(req()).catch((x: unknown) => x)) as ModelError
    expect(filtered).toMatchObject({ kind: 'rejected' })
    expect(modelErrorDetail(filtered)).toBe('content_filter')
  })

  it('a busy gateway and its own timeout are told apart from an unavailable model', async () => {
    const { runner } = await setup([
      { status: 429, json: { error: { message: 'busy', code: 'gateway_busy' } } },
      { status: 504, json: { error: { message: 'timeout', code: 'gateway_timeout' } } },
      { status: 502, json: { error: { message: 'bad gateway', provider_code: 'not_a_code' } } },
    ])
    const errors: ModelError[] = []
    for (let i = 0; i < 3; i++)
      errors.push((await runner.run(req()).catch((x: unknown) => x)) as ModelError)
    expect(errors.map((e) => [e.kind, e.status, e.providerCode])).toEqual([
      ['busy', 429, undefined],
      ['timeout', 504, undefined],
      ['unavailable', 502, undefined],
    ])
    expect(errors.map(modelErrorCode)).toEqual(['model_busy', 'model_timeout', 'model_unavailable'])
  })

  it('maps a caller abort to timeout', async () => {
    const { runner } = await setup([
      { status: 200, json: completion({ content: 'x' }), delayMs: 2000 },
    ])
    const ac = new AbortController()
    const p = runner.run(req(), ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('error messages never contain the token, the body or the request content', async () => {
    const leak = `leak ${TOKEN} secret-body`
    const { runner } = await setup([
      { status: 500, body: leak },
      { status: 400, body: leak },
      { status: 200, body: leak },
    ])
    for (let i = 0; i < 3; i++) {
      const e = await runner
        .run(req({ messages: [{ role: 'user', content: 'private-prompt' }] }))
        .catch((x) => x)
      expect(e.message).not.toContain(TOKEN)
      expect(e.message).not.toContain('secret-body')
      expect(e.message).not.toContain('private-prompt')
    }
  })

  it('uses an injected fetch', async () => {
    const calls: string[] = []
    const runner = llmApiRunner({
      baseUrl: 'http://x',
      token: TOKEN,
      model: 'm',
      backend: 'b',
      fetch: async (url) => {
        calls.push(String(url))
        return new Response(JSON.stringify(completion({ content: 'hi' })))
      },
    })
    const res = await runner.run(req())
    expect(res.message.content).toBe('hi')
    expect(calls).toEqual(['http://x/v1/chat/completions'])
  })

  it('maps content_filter to rejected and unknown finish reasons to bad_response', async () => {
    const { runner } = await setup([
      { status: 200, json: completion({ content: 'x' }, 'content_filter') },
      { status: 200, json: completion({ content: 'x' }, 'weird') },
      { status: 200, json: completion({ content: 'x' }, 'length') },
      {
        status: 200,
        json: {
          choices: [{ message: { content: 'x' }, finish_reason: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
    ])
    await expect(runner.run(req())).rejects.toMatchObject({ kind: 'rejected' })
    await expect(runner.run(req())).rejects.toMatchObject({ kind: 'bad_response' })
    expect((await runner.run(req())).finishReason).toBe('length')
    expect((await runner.run(req())).finishReason).toBe('stop')
  })

  it('does not follow redirects and reports unavailable', async () => {
    const { runner, server } = await setup([
      { status: 307, body: '' },
      { status: 200, json: completion({ content: 'x' }) },
    ])
    await expect(runner.run(req())).rejects.toMatchObject({ kind: 'unavailable', status: 307 })
    expect(server.requests).toHaveLength(1)
  })
})
