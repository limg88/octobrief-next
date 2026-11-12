import type { BackendId, ProjectId } from '@octobrief/domain'

export type JsonSchema = Record<string, unknown>

/** Never carry project data in tool names or ids: they are not pseudonymized. */
export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

/** Product-authored only: never carry project data (specs are not pseudonymized). */
export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** Product-authored only: never carry project data (not pseudonymized). */
  responseSchema?: { name: string; schema: JsonSchema }
  maxOutputTokens?: number
  /** Only the project: its data nature is looked up by the guard, never taken from the request. */
  context: { projectId: ProjectId }
}

export interface ModelResponse {
  message: Extract<ChatMessage, { role: 'assistant' }>
  finishReason: 'stop' | 'tool_calls' | 'length'
  usage: { inputTokens: number; outputTokens: number }
  backend: BackendId
}

/** Dimensions of every stored and query vector (the `vector(1024)` columns). */
export const EMBEDDING_DIMENSIONS = 1024
/** Texts per embedding call: the compile and the reindex send them in blocks of this size. */
export const EMBEDDING_BATCH_SIZE = 32
/** Most texts the gateway takes in one embedding call. */
export const MAX_EMBEDDING_INPUTS = 64
/**
 * Characters of one text sent for embedding, after pseudonymization: a longer text is cut (the
 * encoder never truncates by itself, it would refuse the whole call).
 */
export const MAX_EMBEDDING_TEXT_CHARS = 8_000

/** The encoder of the vectors: the gateway alias and the digest of the model behind it. */
export interface EmbeddingModel {
  model: string
  digest: string
}

export interface EmbedRequest {
  /** Project data: pseudonymized (index-free placeholders) before it leaves. */
  texts: string[]
  /** Only the project: its data nature is looked up by the guard. */
  context: { projectId: ProjectId }
}

export interface EmbedResponse {
  /** One unit-length vector of `EMBEDDING_DIMENSIONS` per text, in order. */
  vectors: number[][]
  /** The encoder the vectors belong to: store it beside them, compare it before using them. */
  encoder: EmbeddingModel
  usage: { inputTokens: number }
  backend: BackendId
}

export interface ModelRunner {
  readonly backend: BackendId
  run(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
  /**
   * Present only when an embedding model is configured: the encoder (its alias, digest and
   * backend). The guard checks that backend, not the chat one.
   */
  readonly embedding?: EmbeddingModel & { backend: BackendId }
  /** Vectors of texts; present exactly when `embedding` is. */
  embed?(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>
  /**
   * Output tokens of a structured answer (a question, a slot of a recipe, a review) on this
   * backend, when the Admin set them; `MAX_ANSWER_TOKENS` otherwise.
   */
  readonly answerOutputTokens?: number
}

/**
 * Output tokens of a structured answer (the answer of a question, the text of a slot of a
 * recipe) without a budget of the backend: enough for the contract and the model's reasoning,
 * which some backends count in the same budget (the Claude seat does, and refuses an answer that
 * reaches it: the Admin gives such a backend a larger one), small enough that a runaway answer is
 * cut and asked again.
 */
export const MAX_ANSWER_TOKENS = 4000

/** The output budget of a structured answer on this runner's backend. */
export const answerTokensOf = (runner: ModelRunner): number =>
  runner.answerOutputTokens ?? MAX_ANSWER_TOKENS

/** Every kind has a PM-facing text under `errors.model_<kind>` in apps/web/messages/it.json. */
export const MODEL_ERROR_KINDS = [
  'timeout',
  'unavailable',
  // The model or the gateway is busy (HTTP 429): retryable a little later.
  'busy',
  'bad_response',
  'rejected',
  'not_allowed',
] as const
export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number]

/**
 * The codes the gateway gives, cleaned, when the provider refused a call (`error.provider_code`):
 * only these are kept, never the text of the provider. Every code has a PM-facing text under
 * `errors.model_<code>` in apps/web/messages/it.json.
 */
export const PROVIDER_CODES = [
  'tool_use_failed',
  'json_validate_failed',
  'invalid_tool_message',
  'invalid_assistant_message',
  'invalid_message',
  'unsupported_parameter',
  'context_length_exceeded',
  'model_not_found',
  'model_decommissioned',
  'unrecognized',
  // The codes of the Claude seat behind the gateway.
  'rate_limit',
  'authentication',
  'max_turns',
  'overloaded',
  'connection',
  'output_limit',
] as const
export type ProviderCode = (typeof PROVIDER_CODES)[number]

export const isProviderCode = (value: unknown): value is ProviderCode =>
  typeof value === 'string' && (PROVIDER_CODES as readonly string[]).includes(value)

/**
 * The gateway's own codes that say what a provider code would: its budget check refuses an
 * answer at or over `max_tokens` with 422 `output_limit_exceeded` and no `provider_code`, and a
 * prompt over the context of a local model with 400 `context_length_exceeded`, and a final JSON
 * that does not match the schema with 502 `structured_output_invalid`.
 */
const PROVIDER_CODE_OF_GATEWAY_CODE: Readonly<Record<string, ProviderCode>> = {
  output_limit_exceeded: 'output_limit',
  context_length_exceeded: 'context_length_exceeded',
  structured_output_invalid: 'json_validate_failed',
}

/** The provider code a code of the gateway implies, when it implies one. */
export const providerCodeOfGatewayCode = (code: string): ProviderCode | undefined =>
  Object.hasOwn(PROVIDER_CODE_OF_GATEWAY_CODE, code)
    ? PROVIDER_CODE_OF_GATEWAY_CODE[code]
    : undefined

/** The shape of a code kept for diagnostics: a short identifier, never words of a message. */
const GATEWAY_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** A code of the gateway (`error.code`) worth keeping: a short identifier, else nothing. */
export const safeGatewayCode = (value: unknown): string | undefined =>
  typeof value === 'string' && GATEWAY_CODE.test(value) ? value : undefined

export class ModelError extends Error {
  readonly status?: number
  /** Why the provider refused the call, as the gateway tells it; absent when it does not. */
  readonly providerCode?: ProviderCode
  /**
   * The gateway's own code of the refusal (`error.code`, such as `output_limit_exceeded`), or the
   * finish reason that refused the answer: a diagnostic only, never shown to the PM.
   */
  readonly gatewayCode?: string
  readonly kind: ModelErrorKind

  constructor(
    kind: ModelErrorKind,
    message: string,
    status?: number,
    providerCode?: ProviderCode,
    gatewayCode?: string,
  ) {
    super(message)
    this.name = 'ModelError'
    this.kind = kind
    if (status !== undefined) this.status = status
    if (providerCode !== undefined) this.providerCode = providerCode
    const code = safeGatewayCode(gatewayCode)
    if (code !== undefined) this.gatewayCode = code
  }
}

/**
 * The diagnostic beside the stored code of a failed model call: the HTTP status, the gateway's
 * code and the provider's, when known (`http 422, output_limit_exceeded`). Codes only, never the
 * words of a message or any content; null when there is nothing to add.
 */
export function modelErrorDetail(error: ModelError): string | null {
  const parts = [
    ...(error.status !== undefined ? [`http ${error.status}`] : []),
    ...(error.gatewayCode !== undefined ? [error.gatewayCode] : []),
    // A provider code the gateway's own code already implies says nothing more.
    ...(error.providerCode !== undefined &&
    error.providerCode !== error.gatewayCode &&
    (error.gatewayCode === undefined ||
      providerCodeOfGatewayCode(error.gatewayCode) !== error.providerCode)
      ? [error.providerCode]
      : []),
  ]
  return parts.length ? parts.join(', ') : null
}

/**
 * The stored code of a failed model call, a key under `errors.` of the PM messages: the code of
 * the provider when the gateway gave one (`model_tool_use_failed`), else the kind
 * (`model_rejected`).
 */
export function modelErrorCode(error: ModelError): string {
  return error.providerCode ? `model_${error.providerCode}` : `model_${error.kind}`
}

/**
 * The model wrote a tool call the provider could not read: a failure of that one generation,
 * which the same call may not repeat. The only refusal a call is made again for, once.
 */
export const isInvalidToolCall = (error: unknown): boolean =>
  error instanceof ModelError && error.providerCode === 'tool_use_failed'

/** The gateway refused the answer at its output budget (422 `output_limit`). */
export const isOutputLimit = (error: unknown): boolean =>
  error instanceof ModelError && error.providerCode === 'output_limit'

/** What is wrong with the vectors the gateway returned. */
export type EmbeddingDefect = 'cardinality' | 'dimension' | 'not_finite' | 'not_normalized'

/** A response of the embedding endpoint whose vectors cannot be stored: never used, never kept. */
export class EmbeddingResponseError extends ModelError {
  readonly defect: EmbeddingDefect

  constructor(defect: EmbeddingDefect) {
    super('bad_response', `embeddings are not valid (${defect})`)
    this.name = 'EmbeddingResponseError'
    this.defect = defect
  }
}
