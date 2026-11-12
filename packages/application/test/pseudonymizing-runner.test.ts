import { newId, type ProjectId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { MAX_EMBEDDING_TEXT_CHARS, type ModelResponse, type ModelRunner } from '../src/index.ts'
import { pseudonymizingRunner } from '../src/model/pseudonymizing-runner.ts'
import { fakeModelRunner } from './fake-model-runner.ts'

const people = async () => [{ displayName: 'Mario Rossi', email: 'mario.rossi@acme.it' }]
const projectId = newId<ProjectId>()
const ctx = { projectId }
const reply = (over: Partial<ModelResponse> = {}): ModelResponse => ({
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
  backend: 'fake',
  ...over,
})

describe('pseudonymizingRunner', () => {
  it('never sends names, emails or phones to the inner runner, also inside tool results and arguments', async () => {
    const inner = fakeModelRunner([reply()])
    const runner = pseudonymizingRunner(inner, people)
    await runner.run({
      messages: [
        { role: 'system', content: 'Parla con Mario Rossi' },
        { role: 'user', content: 'Scrivi a mario.rossi@acme.it o chiama +39 333 1234567' },
        {
          role: 'assistant',
          content: 'Cerco Mario Rossi',
          toolCalls: [
            {
              id: 'c1',
              name: 'find',
              arguments: { q: 'Mario Rossi', n: 3, deep: { e: ['mario.rossi@acme.it'] } },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: '{"owner":"Mario Rossi","tel":"+39 333 1234567"}',
        },
      ],
      context: ctx,
    })
    // Only the messages: the random project id could contain the digits looked for below.
    const sent = JSON.stringify(inner.requests.map((r) => r.messages))
    expect(sent).not.toContain('Mario')
    expect(sent).not.toContain('Rossi')
    expect(sent).not.toContain('acme.it')
    expect(sent).not.toContain('333')
    expect(sent).toContain('[PERSONA_1]')
    // non-string leaves and keys are untouched
    expect(inner.requests[0]?.messages[2]).toMatchObject({
      toolCalls: [{ arguments: { n: 3, deep: { e: ['[EMAIL_1]'] } } }],
    })
  })

  it('restores names in the final answer and in tool call arguments', async () => {
    const inner = fakeModelRunner([
      reply({
        message: {
          role: 'assistant',
          content: 'Ha scritto [PERSONA_1] ([EMAIL_1])',
          toolCalls: [{ id: 'c', name: 'find', arguments: { who: '[PERSONA_1]', k: 2 } }],
        },
        finishReason: 'tool_calls',
      }),
    ])
    const res = await pseudonymizingRunner(inner, people).run({
      messages: [{ role: 'user', content: 'Chi è Mario Rossi? mario.rossi@acme.it' }],
      context: ctx,
    })
    expect(res.message.content).toBe('Ha scritto Mario Rossi (mario.rossi@acme.it)')
    expect(res.message.toolCalls?.[0]?.arguments).toEqual({ who: 'Mario Rossi', k: 2 })
  })

  it('never writes the link or the code of a meeting back in clear in the answer', async () => {
    const inner = fakeModelRunner([
      reply({
        message: {
          role: 'assistant',
          content: '[PERSONA_1] entra con [LINK_RIUNIONE_1] e [CODICE_RIUNIONE_1]',
        },
      }),
    ])
    const res = await pseudonymizingRunner(inner, people).run({
      messages: [
        {
          role: 'user',
          content:
            'Mario Rossi: https://teams.microsoft.com/meet/2718281828?p=QuarzoLink1 Passcode: Ab3xY9',
        },
      ],
      context: ctx,
    })
    const sent = JSON.stringify(inner.requests[0]?.messages)
    expect(sent).not.toContain('teams.microsoft.com')
    expect(sent).not.toContain('Ab3xY9')
    expect(res.message.content).toBe(
      'Mario Rossi entra con [LINK_RIUNIONE_1] e [CODICE_RIUNIONE_1]',
    )
  })

  it('walks JSON tool results: no identity in clear and the content stays valid JSON', async () => {
    const inner = fakeModelRunner([reply()])
    const nick = { displayName: 'Anna "Nana" Bianchi' }
    const result = JSON.stringify({
      owner: 'Mario Rossi',
      mail: 'mario.rossi@acme.it',
      tel: '+39 333 1234567',
      who: 'Anna "Nana" Bianchi',
      n: 1,
    })
    await pseudonymizingRunner(inner, async () => [...(await people()), nick]).run({
      messages: [{ role: 'tool', toolCallId: 'c', content: result }],
      context: ctx,
    })
    const msg = inner.requests[0]?.messages[0]
    const content = (msg as { content: string }).content
    const parsed = JSON.parse(content)
    expect(parsed.n).toBe(1)
    for (const secret of ['Mario', 'Rossi', 'acme.it', '333', 'Anna', 'Nana', 'Bianchi']) {
      expect(content).not.toContain(secret)
    }
  })

  it('restores JSON content with names containing quotes as valid JSON', async () => {
    const nick = { displayName: 'Anna "Nana" Bianchi' }
    const inner = fakeModelRunner([
      reply({ message: { role: 'assistant', content: '{"who":"[PERSONA_1]","n":2}' } }),
    ])
    const res = await pseudonymizingRunner(inner, async () => [nick]).run({
      messages: [{ role: 'user', content: 'Anna "Nana" Bianchi' }],
      context: ctx,
    })
    expect(JSON.parse(res.message.content ?? '')).toEqual({ who: 'Anna "Nana" Bianchi', n: 2 })
  })

  it('does not leak phone numbers carried by numeric JSON leaves', async () => {
    const inner = fakeModelRunner([reply()])
    const big = '12345678901234567890'
    await pseudonymizingRunner(inner, people).run({
      messages: [
        { role: 'tool', toolCallId: 'a', content: '{"tel":3331234567}' },
        { role: 'tool', toolCallId: 'b', content: '[3331234567, 12]' },
        { role: 'tool', toolCallId: 'c', content: `{"id":${big}}` },
      ],
      context: ctx,
    })
    const sent = inner.requests[0]?.messages.map((m) => (m as { content: string }).content) ?? []
    expect(sent.join('')).not.toMatch(/3331234567|12345678901/)
    expect(JSON.parse(sent[0] ?? '')).toEqual({ tel: '[TELEFONO_1]' })
    expect(JSON.parse(sent[1] ?? '')[1]).toBe(12)
  })

  it('walks a JSON string document as a whole', async () => {
    const nick = { displayName: 'Anna "Nana" Bianchi' }
    const inner = fakeModelRunner([reply()])
    await pseudonymizingRunner(inner, async () => [nick]).run({
      messages: [{ role: 'user', content: JSON.stringify('Anna "Nana" Bianchi') }],
      context: ctx,
    })
    const msg = inner.requests[0]?.messages[0]
    expect(JSON.parse((msg as { content: string }).content)).toBe('[PERSONA_1]')
  })

  it('keeps null content and tolerates responses without tool calls', async () => {
    const inner = fakeModelRunner([reply({ message: { role: 'assistant', content: null } })])
    const res = await pseudonymizingRunner(inner, people).run({
      messages: [{ role: 'user', content: 'x' }],
      context: ctx,
    })
    expect(res.message.content).toBeNull()
  })

  it('does not pseudonymize tool specs and uses a fresh mapping per run', async () => {
    const inner = fakeModelRunner([reply(), reply()])
    const runner = pseudonymizingRunner(inner, people)
    const tools = [{ name: 'find_Mario', description: 'Mario Rossi lookup', parameters: {} }]
    await runner.run({
      messages: [{ role: 'user', content: 'Mario Rossi' }],
      tools,
      context: ctx,
    })
    await runner.run({
      messages: [{ role: 'user', content: 'ciao Mario Rossi' }],
      context: ctx,
    })
    expect(inner.requests[0]?.tools).toEqual(tools)
    expect(inner.requests[1]?.messages[0]).toEqual({ role: 'user', content: 'ciao [PERSONA_1]' })
  })
})

describe('the texts of an embedding', () => {
  it('are cut at their limit on a whole character, never half of a pair', async () => {
    const sent: string[][] = []
    const inner: ModelRunner = {
      ...fakeModelRunner([]),
      embedding: { model: 'enc', digest: 'd', backend: 'fake' },
      async embed(req) {
        sent.push(req.texts)
        return {
          vectors: req.texts.map(() => []),
          encoder: { model: 'enc', digest: 'd' },
          usage: { inputTokens: 1 },
          backend: 'fake',
        }
      },
    }
    const runner = pseudonymizingRunner(inner, async () => [])
    const run = (n: number) => 'a'.repeat(n)
    // An emoji (two UTF-16 units) straddles the limit, or ends exactly on it.
    const straddling = run(MAX_EMBEDDING_TEXT_CHARS - 1).concat('😀tail')
    const fitting = run(MAX_EMBEDDING_TEXT_CHARS - 2).concat('😀tail')
    await runner.embed?.({ texts: [straddling, fitting, 'breve'], context: ctx })
    const [a, b, c] = sent[0] ?? []
    expect(a).toBe(run(MAX_EMBEDDING_TEXT_CHARS - 1))
    expect(b).toBe(run(MAX_EMBEDDING_TEXT_CHARS - 2).concat('😀'))
    expect(c).toBe('breve')
    // No lone half of a pair.
    for (const t of [a, b]) expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})
