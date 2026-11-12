import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingModel,
  EmbeddingResponseError,
  type EmbedRequest,
  type EmbedResponse,
  ModelError,
} from '@octobrief/application'
import { z } from 'zod'

// Vectors from a local Ollama (`POST /api/embed`): nothing leaves the machine.

export const OLLAMA_BACKEND = 'ollama'
export const DEFAULT_OLLAMA_TIMEOUT_MS = 60_000
/** Ollama gives no digest with the vectors: the model tag alone names the encoder. */
const UNPINNED_DIGEST = 'unpinned'
/** How far from 1 the length of a vector may be before it is normalized again. */
const UNIT_TOLERANCE = 1e-3

const responseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
  prompt_eval_count: z.number().int().nonnegative().optional(),
})

export interface OllamaEmbedderOptions {
  readonly baseUrl: string
  /** A model of `EMBEDDING_DIMENSIONS` dimensions, such as `bge-m3`. */
  readonly model: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

export interface Embedder {
  readonly embedding: EmbeddingModel & { backend: string }
  embed(request: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>
}

function unit(vector: readonly number[]): number[] {
  if (vector.length !== EMBEDDING_DIMENSIONS) throw new EmbeddingResponseError('dimension')
  if (!vector.every(Number.isFinite)) throw new EmbeddingResponseError('not_finite')
  const length = Math.hypot(...vector)
  if (length === 0) throw new EmbeddingResponseError('not_normalized')
  return Math.abs(length - 1) <= UNIT_TOLERANCE ? [...vector] : vector.map((x) => x / length)
}

export function ollamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const send = options.fetch ?? fetch
  const encoder = { model: options.model, digest: UNPINNED_DIGEST }
  const url = new URL('/api/embed', options.baseUrl)
  return {
    embedding: { ...encoder, backend: OLLAMA_BACKEND },
    async embed(request, signal) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS)
      let response: Response
      try {
        response = await send(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, input: request.texts }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        throw new ModelError(
          timedOut ? 'timeout' : 'unavailable',
          timedOut ? 'ollama did not answer in time' : 'ollama is not reachable',
        )
      }
      if (!response.ok) {
        throw new ModelError('rejected', 'ollama refused the embedding call', response.status)
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) throw new ModelError('bad_response', 'ollama answer is not valid')
      if (parsed.data.embeddings.length !== request.texts.length) {
        throw new EmbeddingResponseError('cardinality')
      }
      return {
        vectors: parsed.data.embeddings.map(unit),
        encoder,
        usage: { inputTokens: parsed.data.prompt_eval_count ?? 0 },
        backend: OLLAMA_BACKEND,
      }
    },
  }
}
