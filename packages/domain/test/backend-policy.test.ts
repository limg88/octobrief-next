import { describe, expect, it } from 'vitest'
import {
  assertBackendAdmissible,
  assertBackendAllowed,
  DomainError,
  namesNeverForReal,
} from '../src/index.ts'

// Which backends the Admin may admit for real data (unit): every one but Groq, under any name of
// the backend, of its provider or of a model mapped to it.

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'ok'
}

describe('the admission of a backend for real data', () => {
  it('groq can never be admitted for real data, by backend name, provider or model alias, from the page or the database', () => {
    // By the name of the backend, whatever its case or suffix.
    for (const backend of ['groq', 'Groq', ' GROQ-cloud ', 'groq_eu', 'groqcloud']) {
      expect(
        codeOf(() => assertBackendAdmissible(backend, {})),
        backend,
      ).toBe('backend_never_for_real')
    }
    // By its provider, a part of the backend id.
    for (const backend of ['llm-api:groq', 'gateway/groq-eu', 'proxy.groq', 'my-groq']) {
      expect(
        codeOf(() => assertBackendAdmissible(backend, {})),
        backend,
      ).toBe('backend_never_for_real')
    }
    // By a model of Groq mapped to it, whatever alias the backend has.
    expect(
      codeOf(() =>
        assertBackendAdmissible('seat', { 'claude-seat': 'seat', 'groq/llama-3.1-8b': 'seat' }),
      ),
    ).toBe('backend_never_for_real')
    expect(codeOf(() => assertBackendAdmissible('seat', { 'Groq/Mixtral': 'seat' }))).toBe(
      'backend_never_for_real',
    )
    // A model of Groq on another backend does not taint this one.
    expect(
      codeOf(() => assertBackendAdmissible('seat', { 'claude-seat': 'seat', 'groq/x': 'groq' })),
    ).toBe('ok')
    // Even listed by hand, a backend of Groq never receives real data.
    expect(codeOf(() => assertBackendAllowed({ dataNature: 'real' }, 'groq', ['groq']))).toBe(
      'backend_not_allowed_for_real_data',
    )
    // A synthetic project may still use it.
    expect(codeOf(() => assertBackendAllowed({ dataNature: 'synthetic' }, 'groq', []))).toBe('ok')
  })

  it('admits any other backend, and the test is on parts of the name, not on letters inside it', () => {
    for (const backend of ['llm-api', 'seat', 'ollama', 'local', 'anthropic:claude', 'nogroq']) {
      expect(codeOf(() => assertBackendAdmissible(backend, { 'claude-seat': backend }))).toBe('ok')
    }
    expect(namesNeverForReal('meta-llama/llama-3')).toBe(false)
    expect(namesNeverForReal('openrouter/groq/llama')).toBe(true)
  })
})
