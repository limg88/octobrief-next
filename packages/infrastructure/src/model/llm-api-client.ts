import {
  type ChatMessage,
  EMBEDDING_DIMENSIONS,
  type EmbeddingModel,
  EmbeddingResponseError,
  type EmbedRequest,
  type EmbedResponse,
  isProviderCode,
  MAX_EMBEDDING_INPUTS,
  ModelError,
  type ModelErrorKind,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
  type ProviderCode,
  providerCodeOfGatewayCode,
  safeGatewayCode,
} from '@octobrief/application'
import type { BackendId } from '@octobrief/domain'
import { z } from 'zod'

export interface LlmApiOptions {
  baseUrl: string
  token: string
  model: string
  backend: BackendId
  /** The encoder of `embed`, with the backend it runs on; without it the runner has no `embed`. */
  embedding?: EmbeddingModel & { backend: BackendId }
  /** Longest wait for one call; `DEFAULT_TIMEOUT_MS` when absent. */
  timeoutMs?: number
  /** Longest wait for one call of the encoder; `timeoutMs` when absent. */
  embeddingTimeoutMs?: number
  /**
   * When the work that uses this runner must be over (epoch milliseconds): no call waits past it,
   * and a call asked after it fails at once as a timeout, before any request.
   */
  deadlineAt?: number
  fetch?: typeof fetch
}

/** The default per-call timeout: under the 90 s the gateway gives this app, so it answers first. */
export const DEFAULT_TIMEOUT_MS = 80_000

/** How far from 1 the length of a returned vector may be (float rounding). */
const NORM_TOLERANCE = 1e-3

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
})

const embeddingsSchema = z.object({
  // The numbers are checked one by one (finite, then the length): an out-of-range one is a defect.
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.unknown()) })),
  usage: z.object({ prompt_tokens: z.number() }),
})

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
  if (m.role === 'assistant') {
    const wire: Record<string, unknown> = { role: 'assistant', content: m.content }
    if (m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }))
    }
    return wire
  }
  return { role: m.role, content: m.content }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function mapFinish(reason: string | null | undefined): ModelResponse['finishReason'] {
  if (reason === undefined || reason === null || reason === 'stop') return 'stop'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') {
    throw new ModelError(
      'rejected',
      'llm-api filtered the response',
      undefined,
      undefined,
      'content_filter',
    )
  }
  throw new ModelError('bad_response', 'llm-api returned an unknown finish reason')
}

/**
 * The vectors of an embedding response, in the order of the texts: exactly one per text (each
 * index once), `EMBEDDING_DIMENSIONS` finite numbers of unit length each. Anything else is an
 * `EmbeddingResponseError` and no vector of the response is used.
 */
function checkedVectors(data: Array<{ index: number; embedding: unknown[] }>, n: number) {
  if (data.length !== n) throw new EmbeddingResponseError('cardinality')
  const out: Array<number[] | undefined> = new Array(n).fill(undefined)
  for (const item of data) {
    if (item.index >= n || out[item.index] !== undefined) {
      throw new EmbeddingResponseError('cardinality')
    }
    const v = item.embedding
    if (v.length !== EMBEDDING_DIMENSIONS) throw new EmbeddingResponseError('dimension')
    let sum = 0
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new EmbeddingResponseError('not_finite')
      }
      sum += x * x
    }
    if (Math.abs(Math.sqrt(sum) - 1) > NORM_TOLERANCE) {
      throw new EmbeddingResponseError('not_normalized')
    }
    out[item.index] = v as number[]
  }
  return out as number[][]
}

/**
 * The codes of a refusal of the gateway: its own (`error.code`, kept only when it is a short
 * identifier) and the cleaned one of the provider, when it is one Octobrief knows (given as
 * `provider_code`, else implied by the gateway's code). Never the message.
 */
function refusalCodes(text: string): { provider?: ProviderCode; gateway?: string } {
  let error: { code?: unknown; provider_code?: unknown } | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const candidate = (parsed as { error?: unknown } | null)?.error
    if (typeof candidate === 'object' && candidate !== null) error = candidate
  } catch {
    return {}
  }
  if (!error) return {}
  const gateway = safeGatewayCode(error.code)
  const provider = isProviderCode(error.provider_code)
    ? error.provider_code
    : gateway !== undefined
      ? providerCodeOfGatewayCode(gateway)
      : undefined
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(gateway !== undefined ? { gateway } : {}),
  }
}

/** A refusal of the gateway as a `ModelError` of `kind`, with its status and codes. */
function refusal(kind: ModelErrorKind, message: string, status: number, text: string) {
  const codes = refusalCodes(text)
  return new ModelError(kind, message, status, codes.provider, codes.gateway)
}

/**
 * OpenAI-compatible client towards the llm-api gateway. A failed call is never retried. The
 * content of an answer in a response format is not checked here: the caller parses it.
 * Error mapping: abort/timeout and the gateway's 504 -> timeout; 429 (a busy gateway, a quota
 * of the provider; retryable later) -> busy; network and other 5xx -> unavailable; other 4xx ->
 * rejected; with the HTTP status, the gateway's own code (`error.code`) and the cleaned code of
 * the provider when the gateway gives one (`rate_limit`, `overloaded`, `output_limit`…) or its
 * own code implies one (422 `output_limit_exceeded` is `output_limit`); invalid payloads -> bad_response (for
 * embeddings, vectors of the wrong number, size or length -> `EmbeddingResponseError`).
 * Messages are fixed text (plus the HTTP status): never the token, body or request content.
 */
export function llmApiRunner(opts: LlmApiOptions): ModelRunner {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const base = opts.baseUrl.replace(/\/+$/, '')

  /** One POST to the gateway: the JSON of a 2xx answer (or that it is not JSON), else an error. */
  async function post(
    path: string,
    body: unknown,
    projectId: string,
    signal: AbortSignal | undefined,
    waitMs: number,
  ): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const left = opts.deadlineAt === undefined ? waitMs : opts.deadlineAt - Date.now()
    if (left <= 0) throw new ModelError('timeout', 'llm-api request past its deadline')
    const timeout = AbortSignal.timeout(Math.min(waitMs, left))
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let text: string
    let status: number
    try {
      const res = await doFetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.token}`,
          'x-octobrief-project': projectId,
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'manual',
      })
      status = res.status
      text = await res.text()
    } catch {
      if (combined.aborted) throw new ModelError('timeout', 'llm-api request timed out')
      throw new ModelError('unavailable', 'llm-api unreachable')
    }
    if (status >= 300 && status < 400) {
      throw new ModelError('unavailable', `llm-api redirected (HTTP ${status})`, status)
    }
    if (status === 429) throw refusal('busy', 'llm-api busy (HTTP 429)', status, text)
    if (status === 504) {
      // The gateway closed a call past its own limit: the model took too long.
      throw refusal('timeout', 'llm-api timed out (HTTP 504)', status, text)
    }
    if (status >= 500) {
      throw refusal('unavailable', `llm-api unavailable (HTTP ${status})`, status, text)
    }
    if (status < 200 || status >= 300) {
      throw refusal('rejected', `llm-api rejected the request (HTTP ${status})`, status, text)
    }
    return parseJson(text)
  }

  const runner: ModelRunner = {
    backend: opts.backend,
    async run(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      // The gateway refuses tools and a response format in the same turn: fail before the network.
      if (req.tools?.length && req.responseSchema) {
        throw new ModelError('rejected', 'tools and a response format cannot share a model turn')
      }
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages.map(toWireMessage),
      }
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      }
      if (req.responseSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: req.responseSchema.name,
            schema: req.responseSchema.schema,
            strict: true,
          },
        }
      }
      if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens

      const json = await post(
        '/v1/chat/completions',
        body,
        req.context.projectId,
        signal,
        timeoutMs,
      )
      const parsed = json.ok ? completionSchema.safeParse(json.value) : undefined
      if (!parsed?.success) throw new ModelError('bad_response', 'llm-api response is not valid')
      const choice = parsed.data.choices[0]
      if (!choice) throw new ModelError('bad_response', 'llm-api response is not valid')
      // With a response format the content is handed back as it is: the caller judges its form
      // (and asks again once), so a malformed answer is never a failed call here.
      const { content, tool_calls } = choice.message

      const toolCalls = (tool_calls ?? []).map((c) => {
        const args = parseJson(c.function.arguments)
        if (!args.ok) throw new ModelError('bad_response', 'llm-api tool arguments are not JSON')
        return { id: c.id, name: c.function.name, arguments: args.value }
      })

      const finishReason = mapFinish(choice.finish_reason)
      return {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length ? { toolCalls } : {}),
        },
        finishReason,
        usage: {
          inputTokens: parsed.data.usage.prompt_tokens,
          outputTokens: parsed.data.usage.completion_tokens,
        },
        backend: opts.backend,
      }
    },
  }

  const encoder = opts.embedding
  if (!encoder) return runner
  return {
    ...runner,
    embedding: encoder,
    async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
      const n = req.texts.length
      // The gateway takes 1 to 64 non-empty texts: anything else fails before the network.
      if (n === 0 || n > MAX_EMBEDDING_INPUTS || req.texts.some((t) => t.length === 0)) {
        throw new ModelError('rejected', 'embedding inputs are 1 to 64 non-empty texts')
      }
      const body = {
        model: encoder.model,
        input: req.texts,
        encoding_format: 'float',
        dimensions: EMBEDDING_DIMENSIONS,
      }
      const json = await post(
        '/v1/embeddings',
        body,
        req.context.projectId,
        signal,
        opts.embeddingTimeoutMs ?? timeoutMs,
      )
      const parsed = json.ok ? embeddingsSchema.safeParse(json.value) : undefined
      if (!parsed?.success) throw new ModelError('bad_response', 'llm-api response is not valid')
      return {
        vectors: checkedVectors(parsed.data.data, n),
        encoder: { model: encoder.model, digest: encoder.digest },
        usage: { inputTokens: parsed.data.usage.prompt_tokens },
        backend: encoder.backend,
      }
    },
  }
}
