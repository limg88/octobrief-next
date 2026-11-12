import { newId, type ProjectId, type UserId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import { transcriptAsText } from '../src/ask/tool-loop.ts'
import {
  MAX_TOOL_CALLS_PER_TURN,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  runToolLoop,
  sendableTranscript,
  type Tool,
  type ToolContext,
} from '../src/index.ts'
import { fakeModelRunner } from './fake-model-runner.ts'

const usage = { inputTokens: 1, outputTokens: 1 }
const toolTurn = (name: string, args: unknown, id = 'c1'): ModelResponse => ({
  message: { role: 'assistant', content: null, toolCalls: [{ id, name, arguments: args }] },
  finishReason: 'tool_calls',
  usage,
  backend: 'fake',
})
const finalTurn = (content: string): ModelResponse => ({
  message: { role: 'assistant', content },
  finishReason: 'stop',
  usage,
  backend: 'fake',
})
const projectId = newId<ProjectId>()
const req = (): ModelRequest => ({
  messages: [{ role: 'user', content: 'go' }],
  context: { projectId },
})
const userId = newId<UserId>()
const opts = { userId }
const echo = (calls: unknown[] = []): Tool => ({
  spec: { name: 'echo', description: 'd', parameters: {} },
  async execute(args, c) {
    calls.push([args, c.projectId])
    return 'echoed'
  },
})

describe('runToolLoop', () => {
  it('gives every tool the project and the user the loop runs for', async () => {
    const seen: ToolContext[] = []
    const tool: Tool = {
      spec: { name: 'who', description: 'd', parameters: {} },
      async execute(_args, ctx) {
        seen.push(ctx)
        return 'ok'
      },
    }
    const runner = fakeModelRunner([toolTurn('who', {}), finalTurn('done')])
    await runToolLoop(runner, req(), [tool], { userId })
    expect(seen).toEqual([{ projectId, userId }])
  })

  it('executes requested tools and returns the final answer with the read log', async () => {
    const runner = fakeModelRunner([
      toolTurn('echo', { a: 1 }),
      toolTurn('echo', { a: 2 }, 'c2'),
      finalTurn('done'),
    ])
    const calls: unknown[] = []
    const original = req()
    const out = await runToolLoop(runner, original, [echo(calls)], opts)
    expect(out.final?.message.content).toBe('done')
    expect(out.turns).toBe(3)
    expect(out.reads).toEqual([
      { tool: 'echo', args: { a: 1 } },
      { tool: 'echo', args: { a: 2 } },
    ])
    expect(calls).toEqual([
      [{ a: 1 }, projectId],
      [{ a: 2 }, projectId],
    ])
    expect(runner.requests[2]?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { a: 1 } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'echoed' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c2', name: 'echo', arguments: { a: 2 } }],
      },
      { role: 'tool', toolCallId: 'c2', content: 'echoed' },
    ])
    expect(original.messages).toHaveLength(1)
  })

  it('returns the whole conversation, tool exchanges and final answer included', async () => {
    const runner = fakeModelRunner([toolTurn('echo', { a: 1 }), finalTurn('done')])
    const result = await runToolLoop(runner, req(), [echo()], opts)
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('runs at most eight calls of one turn; the others get a too_many_calls result', async () => {
    const calls: unknown[] = []
    const many: ModelResponse = {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: Array.from({ length: 10 }, (_, i) => ({
          id: `c${i}`,
          name: 'echo',
          arguments: { i },
        })),
      },
      finishReason: 'tool_calls',
      usage,
      backend: 'fake',
    }
    const runner = fakeModelRunner([many, finalTurn('done')])
    const result = await runToolLoop(runner, req(), [echo(calls)], opts)
    expect(calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN)
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(8)
    const results = result.messages.filter((m) => m.role === 'tool')
    expect(results).toHaveLength(10)
    expect(results.slice(8).map((m) => m.content)).toEqual([
      '{"error":"too_many_calls"}',
      '{"error":"too_many_calls"}',
    ])
    expect(result.reads).toHaveLength(8)
  })

  it('answers unknown tools with an error tool message and continues', async () => {
    const runner = fakeModelRunner([toolTurn('nope', {}), finalTurn('ok')])
    const out = await runToolLoop(runner, req(), [echo()], opts)
    expect(out.final?.message.content).toBe('ok')
    expect(runner.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      content: '{"error":"unknown_tool"}',
    })
  })

  it('hides exceptions of a failing tool from the model and continues', async () => {
    const boom: Tool = {
      spec: { name: 'boom', description: 'd', parameters: {} },
      async execute() {
        throw new Error('secret db failure')
      },
    }
    const runner = fakeModelRunner([toolTurn('boom', {}), finalTurn('ok')])
    const out = await runToolLoop(runner, req(), [boom], opts)
    expect(out.reads).toEqual([{ tool: 'boom', args: {} }])
    expect(JSON.stringify(runner.requests[1])).not.toContain('secret')
    expect(runner.requests[1]?.messages.at(-1)).toMatchObject({
      content: '{"error":"tool_failed"}',
    })
  })

  it('fails with bad_response after too many turns', async () => {
    const runner = fakeModelRunner([
      toolTurn('echo', {}),
      toolTurn('echo', {}),
      toolTurn('echo', {}),
    ])
    await expect(
      runToolLoop(runner, req(), [echo()], { ...opts, maxTurns: 2 }),
    ).rejects.toMatchObject({
      kind: 'bad_response',
      message: 'too many turns',
    })
    expect(runner.requests).toHaveLength(2)
  })

  it('treats a tool_calls finish without calls as the final answer', async () => {
    const odd: ModelResponse = { ...finalTurn('x'), finishReason: 'tool_calls' }
    const out = await runToolLoop(fakeModelRunner([odd]), req(), [], opts)
    expect(out.turns).toBe(1)
  })

  it('does not execute tools requested on the last allowed turn', async () => {
    const calls: unknown[] = []
    const runner = fakeModelRunner([toolTurn('echo', { a: 1 })])
    await expect(
      runToolLoop(runner, req(), [echo(calls)], { ...opts, maxTurns: 1 }),
    ).rejects.toMatchObject({
      kind: 'bad_response',
    })
    expect(calls).toHaveLength(0)
  })

  it('with onTurnLimit stop returns the conversation without the unexecuted calls', async () => {
    const calls: unknown[] = []
    const runner = fakeModelRunner([toolTurn('echo', { a: 1 }), toolTurn('echo', { a: 2 })])
    const out = await runToolLoop(runner, req(), [echo(calls)], {
      ...opts,
      maxTurns: 2,
      onTurnLimit: 'stop',
    })
    expect(out.turnLimitReached).toBe(true)
    expect(out.turns).toBe(2)
    expect(calls).toHaveLength(1)
    expect(out.messages.at(-1)?.role).toBe('tool')
    expect(out.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('with onOutputLimit stop a reading turn refused at the output budget ends the reading', async () => {
    const calls: unknown[] = []
    const refused = () => {
      throw new ModelError(
        'rejected',
        'llm-api rejected the request (HTTP 422)',
        422,
        'output_limit',
        'output_limit_exceeded',
      )
    }
    const runner = fakeModelRunner([toolTurn('echo', { a: 1 }), refused])
    const out = await runToolLoop(runner, req(), [echo(calls)], {
      ...opts,
      onOutputLimit: 'stop',
    })
    expect(out.outputLimitReached).toBe(true)
    expect(out.final).toBeNull()
    // The refused turn was a call: it counts.
    expect(out.turns).toBe(2)
    expect(calls).toHaveLength(1)
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('without onOutputLimit a reading turn refused at the output budget fails', async () => {
    const refused = () => {
      throw new ModelError(
        'rejected',
        'llm-api rejected the request (HTTP 422)',
        422,
        'output_limit',
      )
    }
    await expect(runToolLoop(fakeModelRunner([refused]), req(), [], opts)).rejects.toBeInstanceOf(
      ModelError,
    )
  })

  it('with onOutputLimit stop other model errors still fail the reading', async () => {
    const busy = () => {
      throw new ModelError('busy', 'llm-api rejected the request (HTTP 429)', 429)
    }
    await expect(
      runToolLoop(fakeModelRunner([busy]), req(), [], { ...opts, onOutputLimit: 'stop' }),
    ).rejects.toMatchObject({ kind: 'busy' })
  })

  it('an answer before the limit is not a reached limit', async () => {
    const out = await runToolLoop(fakeModelRunner([finalTurn('x')]), req(), [], {
      ...opts,
      onTurnLimit: 'stop',
    })
    expect(out.turnLimitReached).toBe(false)
  })

  it('sendableTranscript leaves out empty assistant messages and tool calls without results', () => {
    const out = sendableTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'echo', arguments: {} }] },
      { role: 'tool', toolCallId: 'a', content: 'r' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'text', toolCalls: [{ id: 'b', name: 'echo', arguments: {} }] },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c', name: 'echo', arguments: {} }] },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'echo', arguments: {} }] },
      { role: 'tool', toolCallId: 'a', content: 'r' },
      { role: 'assistant', content: 'text' },
    ])
  })

  it('transcriptAsText is a new conversation with what the tools returned as text', () => {
    const out = transcriptAsText([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a', name: 'read_evidence', arguments: { evidence_id: 'e1' } },
          { id: 'b', name: 'echo', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: 'a', content: '{"title":"SAL","chunks":["62%"]}' },
      { role: 'tool', toolCallId: 'b', content: 'plain' },
      { role: 'assistant', content: 'Ho letto.' },
      { role: 'user', content: 'answer' },
    ])
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'user'])
    expect(out.some((m) => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls))).toBe(
      false,
    )
    expect(out[0]).toEqual({ role: 'system', content: 'sys' })
    expect(out[3]).toEqual({ role: 'assistant', content: 'Ho letto.' })
    const results = JSON.parse(out[2]?.content as string)
    expect(results.risultati_degli_strumenti).toEqual([
      {
        strumento: 'read_evidence',
        argomenti: { evidence_id: 'e1' },
        risultato: { title: 'SAL', chunks: ['62%'] },
      },
      { strumento: 'echo', argomenti: {}, risultato: 'plain' },
    ])
    expect(results.nota).toContain('dati')
  })

  it('transcriptAsText leaves a conversation without tools as it is', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null },
    ] as const
    expect(transcriptAsText(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ])
  })

  it('passes the abort signal to the runner', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ac = new AbortController()
    const runner = {
      backend: 'fake',
      async run(_r: ModelRequest, signal?: AbortSignal) {
        seen.push(signal)
        return finalTurn('x')
      },
    }
    await runToolLoop(runner, req(), [], { ...opts, signal: ac.signal })
    expect(seen).toEqual([ac.signal])
  })
})
