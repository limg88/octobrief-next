import { appendFileSync } from 'node:fs'
import {
  EMBEDDING_DIMENSIONS,
  type EmbedResponse,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
} from '@octobrief/application'
import { COMPILE_FACTS_PER_CALL, type FactKind, MAX_EXCERPT_LENGTH } from '@octobrief/domain'

// A model that needs no network and always answers the same way: demos and tests run on it, and
// what it receives can be written down to show that no name reaches a model in clear.

export const FAKE_BACKEND = 'fake'
export const FAKE_ENCODER = { model: 'fake-embedding', digest: 'v1' } as const

/** Shortest sentence the fake model reports as a fact: the compile refuses shorter excerpts. */
const MIN_SENTENCE_LENGTH = 8
const MAX_SUBJECT_LENGTH = 60
const MAX_VALUE_LENGTH = 200
const SUBJECT_WORDS = 5

/** The first rule that matches a sentence decides the kind of its fact. */
const KIND_RULES: ReadonlyArray<readonly [FactKind, RegExp]> = [
  ['risk', /\brischi|\britard|\bcriticit/i],
  ['decision', /\bdecis|\bdeciso\b|\bapprovat|\bconcordat/i],
  [
    'milestone',
    /\bmilestone\b|\bscadenza\b|\bconsegna\b|\brilascio\b|\bgo-live\b|\bprevist[oa]\b/i,
  ],
  ['economics', /€|\beuro\b|\bbudget\b|\bcost[oi]\b|\bfattur/i],
  ['action', /\bazion[ei]\b|\bda fare\b|\bdeve\b|\bdovrà\b/i],
  ['status', /\bavanzamento\b|\bstato\b|\bcompletat/i],
]

interface FakeFact {
  kind: FactKind
  subject: string
  statement: string
  value: string | null
  sources: Array<{ n: number; excerpt: string }>
}

function sentencesOf(text: string): string[] {
  return (
    text
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((sentence) => sentence.trim())
      // A Markdown heading names the document: it states nothing.
      .filter((s) => !s.startsWith('#'))
      .filter((s) => s.length >= MIN_SENTENCE_LENGTH && s.length <= MAX_EXCERPT_LENGTH)
  )
}

/** «Label: value» gives a subject and a value; any other sentence its first words. */
function factOf(kind: FactKind, sentence: string, n: number): FakeFact {
  const colon = sentence.indexOf(':')
  const label = colon > 0 ? sentence.slice(0, colon).trim() : ''
  const rest = colon > 0 ? sentence.slice(colon + 1).trim() : ''
  const labelled = label !== '' && label.length <= MAX_SUBJECT_LENGTH && rest !== ''
  return {
    kind,
    subject: labelled ? label : sentence.split(/\s+/u).slice(0, SUBJECT_WORDS).join(' '),
    statement: sentence,
    value: labelled && rest.length <= MAX_VALUE_LENGTH ? rest.replace(/[.!?]+$/u, '') : null,
    sources: [{ n, excerpt: sentence }],
  }
}

/** The facts of a compile request: one per sentence a rule recognizes, in reading order. */
function compiledFacts(content: string): { facts: FakeFact[] } {
  const parsed = JSON.parse(content) as { frammenti?: Array<{ n: number; text: string }> }
  const facts: FakeFact[] = []
  for (const chunk of parsed.frammenti ?? []) {
    for (const sentence of sentencesOf(chunk.text)) {
      const rule = KIND_RULES.find(([, pattern]) => pattern.test(sentence))
      if (rule && facts.length < COMPILE_FACTS_PER_CALL) {
        facts.push(factOf(rule[0], sentence, chunk.n))
      }
    }
  }
  return { facts }
}

/** What the fake model answers, by the name of the response schema of the request. */
const SKILLS: Readonly<Record<string, (content: string) => unknown>> = {
  compiled_facts: compiledFacts,
}

function answer(request: ModelRequest): string {
  const skill = SKILLS[request.responseSchema?.name ?? '']
  const data = request.messages.find((message) => message.role === 'user')
  return JSON.stringify(skill && data?.content ? skill(data.content) : {})
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function hashOf(token: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < token.length; i++) {
    hash = Math.imul(hash ^ token.charCodeAt(i), FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * A unit vector from the words of a text (each word adds to one dimension chosen by its hash):
 * texts that share words are close, so a search on fake vectors still finds what it should.
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
  for (const word of words) {
    const at = hashOf(word) % EMBEDDING_DIMENSIONS
    vector[at] = (vector[at] as number) + 1
  }
  const length = Math.hypot(...vector)
  if (length === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((x) => x / length)
}

export interface FakeRunnerOptions {
  /** A file where every request is appended as one JSON line, as the model received it. */
  readonly transcriptPath?: string | undefined
}

const TRANSCRIPT_MODE = 0o600

export function fakeRunner(options: FakeRunnerOptions = {}): ModelRunner {
  const record = (entry: unknown) => {
    if (options.transcriptPath) {
      appendFileSync(options.transcriptPath, `${JSON.stringify(entry)}\n`, {
        mode: TRANSCRIPT_MODE,
      })
    }
  }
  return {
    backend: FAKE_BACKEND,
    async run(request): Promise<ModelResponse> {
      record({ kind: 'chat', messages: request.messages })
      return {
        message: { role: 'assistant', content: answer(request) },
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        backend: FAKE_BACKEND,
      }
    },
    embedding: { ...FAKE_ENCODER, backend: FAKE_BACKEND },
    async embed(request): Promise<EmbedResponse> {
      record({ kind: 'embed', texts: request.texts })
      return {
        vectors: request.texts.map(fakeEmbedding),
        encoder: FAKE_ENCODER,
        usage: { inputTokens: 0 },
        backend: FAKE_BACKEND,
      }
    },
  }
}
