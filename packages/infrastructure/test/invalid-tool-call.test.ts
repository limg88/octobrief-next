import {
  budgetedRunner,
  estimatedInputTokens,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
  modelErrorCode,
  PROVIDER_CODES,
  RunError,
} from '@octobrief/application'
import { DEFAULT_RUN_CAPS } from '@octobrief/domain/recipe'
import { afterEach, describe, expect, it } from 'vitest'
import { llmApiRunner } from '../src/model/llm-api-client.ts'
import { type FakeLlmApiServer, startFakeLlmApi } from './support/fake-llm-api-server.ts'

const req: ModelRequest = {
  messages: [{ role: 'user', content: 'ciao' }],
  context: { projectId: '00000000-0000-4000-8000-000000000001' as never },
}

const ok: ModelResponse = {
  message: { role: 'assistant', content: 'fatto' },
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
  backend: 'fake',
}

const invalidToolCall = () =>
  new ModelError('rejected', 'llm-api rejected the request (HTTP 400)', 400, 'tool_use_failed')

/** A runner that plays its steps in order: an error is thrown, a response returned. */
function steps(...script: Array<ModelResponse | Error>): ModelRunner & { calls: number } {
  const runner = {
    backend: 'fake',
    calls: 0,
    async run() {
      const step = script[runner.calls++]
      if (step === undefined) throw new Error('script exhausted')
      if (step instanceof Error) throw step
      return step
    },
  }
  return runner
}

function budget(maxModelCalls = 10) {
  return {
    caps: { ...DEFAULT_RUN_CAPS, maxModelCalls },
    price: { inputPerMillion: 1, outputPerMillion: 1 },
    rate: { rate: 1, setAt: new Date(0) },
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    startedAt: Date.now(),
  }
}

describe('a call the model answers with an invalid tool call', () => {
  it('is made once more, counted as a call of the run like any other', async () => {
    const inner = steps(invalidToolCall(), ok)
    const b = budget()
    const res = await budgetedRunner(inner, b).run(req)
    expect(res.message.content).toBe('fatto')
    expect(inner.calls).toBe(2)
    expect(b.usage.modelCalls).toBe(2)
    expect(b.usage.inputTokens).toBe(10)
  })

  it('fails the second time in a row, with the code of the provider kept', async () => {
    const inner = steps(invalidToolCall(), invalidToolCall(), ok)
    const b = budget()
    const error = await budgetedRunner(inner, b)
      .run(req)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ kind: 'rejected', providerCode: 'tool_use_failed' })
    expect(modelErrorCode(error as ModelError)).toBe('model_tool_use_failed')
    expect(inner.calls).toBe(2)
    expect(b.usage.modelCalls).toBe(2)
  })

  it('is not made again past the cap on the calls of the run, and keeps why beside the cap', async () => {
    const inner = steps(invalidToolCall(), ok)
    const b = budget(1)
    const error = await budgetedRunner(inner, b)
      .run(req)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunError)
    expect(error).toMatchObject({ code: 'cap_model_calls', failureCause: 'model_tool_use_failed' })
    expect(inner.calls).toBe(1)
  })

  it('leaves no cause on a cap met without a refused call', async () => {
    const b = budget(1)
    b.usage.modelCalls = 1
    const error = await budgetedRunner(steps(ok), b)
      .run(req)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'cap_model_calls', failureCause: null })
  })

  it('leaves any other refusal as it is: never made again', async () => {
    for (const refusal of [
      new ModelError('rejected', 'llm-api rejected the request (HTTP 400)', 400),
      new ModelError(
        'rejected',
        'llm-api rejected the request (HTTP 400)',
        400,
        'json_validate_failed',
      ),
      new ModelError('timeout', 'llm-api request timed out'),
    ]) {
      const inner = steps(refusal, ok)
      await expect(budgetedRunner(inner, budget()).run(req)).rejects.toBe(refusal)
      expect(inner.calls).toBe(1)
    }
  })
})

describe('the code of the provider on a refusal', () => {
  let server: FakeLlmApiServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('is kept when the gateway gives one of its known codes, never the text of the provider', async () => {
    const refusal = (provider_code: string) => ({
      status: 400,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request_error',
          provider_code,
          message: 'fixed text of the gateway',
        },
      },
    })
    server = await startFakeLlmApi([
      refusal('tool_use_failed'),
      refusal('something_else'),
      { status: 400, body: 'not json' },
    ])
    const runner = llmApiRunner({
      baseUrl: server.url,
      token: 'test-token',
      model: 'm',
      backend: 'groq',
    })
    const codes: unknown[] = []
    for (let i = 0; i < 3; i++) {
      codes.push(
        await runner.run(req).then(
          () => 'ok',
          (e: ModelError) => e.providerCode ?? null,
        ),
      )
    }
    expect(codes).toEqual(['tool_use_failed', null, null])
    expect(PROVIDER_CODES).toContain('tool_use_failed')
    expect(modelErrorCode(new ModelError('rejected', 'x', 400))).toBe('model_rejected')
  })
})

describe('a call the model did not answer', () => {
  const long: ModelRequest = {
    messages: [
      { role: 'system', content: 'a'.repeat(400_000) },
      { role: 'user', content: 'è'.repeat(300_000) },
    ],
    context: req.context,
  }

  it('is estimated by the bytes of what the request carries', () => {
    // 400,000 bytes, then 2 bytes for each «è».
    expect(estimatedInputTokens(long)).toBe(1_000_000)
  })

  it('on a paid backend is charged its estimated input, at the rate of the run', async () => {
    const b = {
      ...budget(),
      price: { inputPerMillion: 2, outputPerMillion: 8 },
      rate: { rate: 0.5, setAt: new Date(0) },
    }
    const timeout = new ModelError('timeout', 'llm-api request timed out')
    await expect(budgetedRunner(steps(timeout), b).run(long)).rejects.toBe(timeout)
    // A million tokens at 2 $ per million, at 0.5 € to the dollar; no tokens are claimed.
    expect(b.usage.estimatedCost).toBeCloseTo(1)
    expect(b.usage.inputTokens).toBe(0)
    expect(b.usage.modelCalls).toBe(1)
  })

  it('on a free backend costs nothing', async () => {
    const b = { ...budget(), price: null, rate: null }
    await expect(
      budgetedRunner(steps(new ModelError('timeout', 'slow')), b).run(long),
    ).rejects.toBeInstanceOf(ModelError)
    expect(b.usage.estimatedCost).toBe(0)
  })

  it('refused by the guard never left, so it costs nothing', async () => {
    const b = { ...budget(), rate: { rate: 1, setAt: new Date(0) } }
    await expect(
      budgetedRunner(steps(new ModelError('not_allowed', 'backend not admitted')), b).run(long),
    ).rejects.toBeInstanceOf(ModelError)
    expect(b.usage.estimatedCost).toBe(0)
  })

  it('repeated after an invalid tool call is charged twice, then the answer at its usage', async () => {
    const b = { ...budget(), rate: { rate: 1, setAt: new Date(0) } }
    const small: ModelRequest = { ...req, messages: [{ role: 'user', content: 'x'.repeat(1000) }] }
    await budgetedRunner(steps(invalidToolCall(), ok), b).run(small)
    // 1,000 estimated input tokens, then 10 in and 5 out, all at 1 $ per million.
    expect(b.usage.estimatedCost).toBeCloseTo(1015 / 1_000_000)
  })

  it('counts the tools the request offers in its estimate', () => {
    const withTools: ModelRequest = {
      ...req,
      tools: [{ name: 'get_fact', description: 'Legge un fatto.', parameters: { type: 'object' } }],
    }
    expect(estimatedInputTokens(withTools)).toBeGreaterThan(estimatedInputTokens(req))
  })
})

describe('the cost of a run', () => {
  it('is priced from the totals of its tokens, without drifting call by call', async () => {
    const calls = 1_000
    const b = {
      ...budget(calls + 1),
      price: { inputPerMillion: 0.1, outputPerMillion: 0.3 },
      rate: { rate: 0.93, setAt: new Date(0) },
      usage: { modelCalls: 0, inputTokens: 7, outputTokens: 3, estimatedCost: 0.25 },
    }
    const runner = budgetedRunner(steps(...Array.from({ length: calls }, () => ok)), b)
    for (let i = 0; i < calls; i++) await runner.run(req)
    // What the run had before, plus all its tokens priced at once.
    const expected = 0.25 + ((calls * 10 * 0.1 + calls * 5 * 0.3) / 1_000_000) * 0.93
    expect(b.usage.estimatedCost).toBe(expected)
  })
})
