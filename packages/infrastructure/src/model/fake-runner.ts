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

/** A passage or a fact the search tool returned. */
interface ReadHit {
  kind: 'chunk' | 'fact'
  title: string
  text: string
  evidence_id?: string
  locator?: unknown
  fact_id?: string
}

const SEARCH_TOOL = 'search_knowledge'
/** Segments of a fake answer at most: a short answer, like the one asked of a real model. */
const MAX_ANSWER_SEGMENTS = 4
/** Words shorter than this say nothing about what a question is about. */
const MIN_TOPIC_WORD = 4
/**
 * A question holding this marker makes the fake model add a number it never read to its first
 * sentence: the way to see, without a real model, that the checks suspend an invented figure.
 */
export const FAKE_INVENTION_MARKER = '#inventa'
const INVENTED_SENTENCE = ' Il totale aggiornato è di 123.456 euro.'

const topicWords = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= MIN_TOPIC_WORD)

/** The question of the PM, as the ask engine sends it (`{"domanda": …}`). */
function questionOf(request: ModelRequest): string {
  for (const message of request.messages) {
    if (message.role !== 'user') continue
    try {
      const parsed = JSON.parse(message.content) as { domanda?: unknown }
      if (typeof parsed.domanda === 'string') return parsed.domanda
    } catch {
      // Not the question: a note of the engine.
    }
  }
  return ''
}

/** Everything the search tool returned in this conversation. */
function hitsRead(request: ModelRequest): ReadHit[] {
  return request.messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    try {
      const parsed = JSON.parse(message.content) as { results?: ReadHit[] }
      return Array.isArray(parsed.results) ? parsed.results : []
    } catch {
      return []
    }
  })
}

const sourceOf = (hit: ReadHit) =>
  hit.kind === 'fact'
    ? { factId: hit.fact_id }
    : { evidenceId: hit.evidence_id, locator: hit.locator }

/** A sentence shaped like an order to the reader: reported by no well-behaved model. */
const ORDER = /\bignora\b|\bistruzion/i

/**
 * The sentences of a passage that speak of the question, at most two; null when none does (a
 * heading, an order addressed to the reader, words about something else).
 */
function relevantText(hit: ReadHit, topic: ReadonlySet<string>): string | null {
  const sentences = sentencesOf(hit.text).filter(
    (sentence) => !ORDER.test(sentence) && topicWords(sentence).some((word) => topic.has(word)),
  )
  return sentences.length > 0 ? sentences.slice(0, 2).join(' ') : null
}

/**
 * The answer to a question from what was read: the passages and facts that share a word with
 * the question, each quoted with its source; facts of the same subject that say different
 * things as a contradiction; nothing relevant as an absence. Never a word that was not read.
 */
function projectAnswer(request: ModelRequest): unknown {
  const topic = new Set(topicWords(questionOf(request)))
  const said = new Set<string>()
  const relevant = hitsRead(request).flatMap((hit) => {
    const text = relevantText(hit, topic)
    // The same words from a passage and from the fact compiled from it are said once.
    if (text === null || said.has(text)) return []
    said.add(text)
    return [{ ...hit, text }]
  })
  const facts = relevant.filter((hit) => hit.kind === 'fact')
  const bySubject = new Map<string, ReadHit[]>()
  for (const fact of facts) bySubject.set(fact.title, [...(bySubject.get(fact.title) ?? []), fact])
  const contradictions = [...bySubject]
    .filter(([, sides]) => sides.length > 1)
    .map(([subject, sides]) => ({
      subject,
      sides: sides.map((side) => ({ value: side.text, source: sourceOf(side) })),
      reason: 'I documenti riportano valori diversi.',
    }))
  const invents = questionOf(request).includes(FAKE_INVENTION_MARKER)
  const segments = relevant.slice(0, MAX_ANSWER_SEGMENTS).map((hit, index) => ({
    text: hit.text + (invents && index === 0 ? INVENTED_SENTENCE : ''),
    nature: 'fact',
    sources: [sourceOf(hit)],
  }))
  const absences =
    segments.length > 0
      ? []
      : [
          {
            question: 'In quale documento si trova questa informazione?',
            proposal: 'Carica il documento o collega la fonte che la riporta.',
          },
        ]
  return { lang: 'it', segments, contradictions, absences }
}

/** What the fake model answers, by the name of the response schema of the request. */
const SKILLS: Readonly<Record<string, (request: ModelRequest) => unknown>> = {
  compiled_facts: (request) => {
    const data = request.messages.find((message) => message.role === 'user')
    return data?.content ? compiledFacts(data.content) : {}
  },
  project_answer: projectAnswer,
}

function answer(request: ModelRequest): string {
  const skill = SKILLS[request.responseSchema?.name ?? '']
  return JSON.stringify(skill ? skill(request) : {})
}

/**
 * A turn with tools: the fake model searches once with the question, then says it has read
 * enough. Only the search tool, only when it is offered.
 */
function toolTurn(request: ModelRequest): ModelResponse {
  const searched = request.messages.some((message) => message.role === 'tool')
  const canSearch = request.tools?.some((tool) => tool.name === SEARCH_TOOL) === true
  const usage = { inputTokens: 0, outputTokens: 0 }
  if (searched || !canSearch) {
    return {
      message: { role: 'assistant', content: 'Lettura completata.' },
      finishReason: 'stop',
      usage,
      backend: FAKE_BACKEND,
    }
  }
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'search-1', name: SEARCH_TOOL, arguments: { query: questionOf(request) } }],
    },
    finishReason: 'tool_calls',
    usage,
    backend: FAKE_BACKEND,
  }
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
      if (request.tools?.length) return toolTurn(request)
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
