import { type ModelRunner, type ProtectionOptions, protectedRunner } from '@octobrief/application'
import type { ModelConfig } from '../config.ts'
import { FAKE_BACKEND, fakeRunner } from './fake-runner.ts'
import { llmApiRunner } from './llm-api-client.ts'
import { type Embedder, OLLAMA_BACKEND, ollamaEmbedder } from './ollama-embedder.ts'

export const LLM_API_BACKEND = 'llm-api'

function chatAdapter(config: ModelConfig): ModelRunner {
  if (config.chat.backend === 'fake') {
    return fakeRunner({
      transcriptPath: config.fakeTranscriptPath,
      inventInDrafts: config.fakeInventsInDrafts,
    })
  }
  const { embedding } = config
  return llmApiRunner({
    baseUrl: config.chat.url,
    token: config.chat.token,
    model: config.chat.model,
    backend: LLM_API_BACKEND,
    ...(config.chat.timeoutMs ? { timeoutMs: config.chat.timeoutMs } : {}),
    ...(embedding.backend === 'llm-api'
      ? {
          embedding: { model: embedding.model, digest: embedding.digest, backend: LLM_API_BACKEND },
        }
      : {}),
  })
}

/** The encoder when it is not the chat adapter's own; null to keep the adapter's, or none. */
function separateEmbedder(config: ModelConfig): Embedder | null {
  const { embedding } = config
  if (embedding.backend === 'ollama') {
    return ollamaEmbedder({ baseUrl: embedding.url, model: embedding.model })
  }
  if (embedding.backend === 'fake' && config.chat.backend !== 'fake') {
    const fake = fakeRunner({
      transcriptPath: config.fakeTranscriptPath,
      inventInDrafts: config.fakeInventsInDrafts,
    })
    return fake.embed && fake.embedding ? { embedding: fake.embedding, embed: fake.embed } : null
  }
  return null
}

/** The chat adapter with the encoder the configuration chose (its own, another one, or none). */
export function modelAdapter(config: ModelConfig): ModelRunner {
  const chat = chatAdapter(config)
  const embedder = separateEmbedder(config)
  if (embedder) {
    return {
      backend: chat.backend,
      run: (request, signal) => chat.run(request, signal),
      embedding: embedder.embedding,
      embed: (request, signal) => embedder.embed(request, signal),
    }
  }
  const ownEncoder = config.embedding.backend === config.chat.backend
  if (ownEncoder) return chat
  return { backend: chat.backend, run: (request, signal) => chat.run(request, signal) }
}

/** The backends the configuration uses: the ones allowed when none are listed. */
export function configuredBackends(config: ModelConfig): string[] {
  const names: Record<ModelConfig['embedding']['backend'], string | null> = {
    fake: FAKE_BACKEND,
    ollama: OLLAMA_BACKEND,
    'llm-api': LLM_API_BACKEND,
    none: null,
  }
  const chat = config.chat.backend === 'fake' ? FAKE_BACKEND : LLM_API_BACKEND
  const encoder = names[config.embedding.backend]
  return [...new Set([chat, ...(encoder ? [encoder] : [])])]
}

/**
 * The only model runner of a process: the configured adapter behind the guard and the
 * pseudonymizer. Every project counts as real data: its backends must be allowed.
 */
export function createModelRunner(
  config: ModelConfig,
  people: ProtectionOptions['people'],
): ModelRunner {
  const allowed = config.allowedBackends ?? configuredBackends(config)
  return protectedRunner(modelAdapter(config), {
    people,
    resolveProject: async () => ({ dataNature: 'real' }),
    allowedForReal: async () => allowed,
  })
}
