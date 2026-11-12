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

type QuotableCell = { testo?: string | null; note?: number[] }

/** A value of the document the writer may quote: its label, its text and the notes it cites. */
interface QuotableValue {
  section: string
  label: string
  text: string
  notes: number[]
}

/** What the writer of a recipe asks for: one text of a document, with what the PM wants changed. */
interface SlotRequest {
  testo_da_scrivere?: {
    id?: string
    istruzioni?: string
    nature_ammesse?: string[]
    massimo_caratteri?: number
  }
  documento?: {
    sezioni?: Array<{
      id: string
      blocchi?: Array<{
        id: string
        tipo: string
        etichetta?: string
        valore?: { testo?: string | null; note?: number[] }
        colonne?: string[]
        righe?: Array<Array<{ testo?: string | null; note?: number[] }>>
      }>
    }>
    note?: Array<{ n: number; fonte?: string }>
  }
  richiesta_del_pm?: string
}

/** A passage of a document the fake model read through the tools. */
interface ReadPassage {
  evidenceId: string
  locator: unknown
  text: string
}

const READ_TOOL = 'read_evidence'
/** A note of the writer that names a file: a document the text may be asked to quote. */
const FILE_NAME = /\.[a-z0-9]{2,5}$/i

/**
 * What a text looks for in a document it reads, by a word of its id: the lines of a meeting
 * that say when it was, who was there, what was decided, who does what, what is at risk.
 */
const SLOT_TOPICS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/time|date/, /^(data|ora):/i],
  [/participant/, /^partecipanti:/i],
  [/decision/, /\bdecid|\bdeciso\b|\bapprov/i],
  [/action/, /\bprepara\b|\bdeve\b|\bentro il\b/i],
  [/risk/, /\brischi/i],
  [/deferred/, /\brinvi/i],
  [/next/, /\bprossim/i],
]

/** Sentences one fake text holds at most. */
const MAX_SLOT_SENTENCES = 2
const DEFAULT_SLOT_CHARS = 400

function slotRequestOf(request: ModelRequest): SlotRequest {
  for (const message of request.messages) {
    if (message.role !== 'user') continue
    try {
      const parsed = JSON.parse(message.content) as SlotRequest
      if (parsed.testo_da_scrivere) return parsed
    } catch {
      // Not the request of a text: a note of the engine.
    }
  }
  return {}
}

/**
 * The values, and the cells of lists and tables, of the document that carry a text and a note;
 * those of the section of the text first.
 */
function quotableValues(slot: SlotRequest): QuotableValue[] {
  const slotId = slot.testo_da_scrivere?.id
  const sections = slot.documento?.sezioni ?? []
  const own = sections.find((section) => section.blocchi?.some((block) => block.id === slotId))
  const ordered = own ? [own, ...sections.filter((section) => section !== own)] : sections
  const quotable = (section: string, label: string | undefined, cell: QuotableCell | undefined) =>
    label && cell?.testo && (cell.note ?? []).length > 0
      ? [{ section, label, text: cell.testo, notes: cell.note ?? [] }]
      : []
  return ordered.flatMap((section) =>
    (section.blocchi ?? []).flatMap((block) => [
      ...(block.tipo === 'valore' ? quotable(section.id, block.etichetta, block.valore) : []),
      ...(block.righe ?? []).flatMap((row) =>
        row.flatMap((cell, column) => quotable(section.id, block.colonne?.[column], cell)),
      ),
    ]),
  )
}

/** The JSON every tool returned in this conversation. */
function toolResults(request: ModelRequest): Array<Record<string, unknown>> {
  return request.messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    try {
      const parsed = JSON.parse(message.content) as unknown
      return typeof parsed === 'object' && parsed !== null
        ? [parsed as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
}

/** The lines of the documents read with `read_evidence`, each where it stands. */
function passagesRead(request: ModelRequest): ReadPassage[] {
  return toolResults(request).flatMap((result) => {
    const { evidence_id: evidenceId, chunks } = result as {
      evidence_id?: string
      chunks?: Array<{ locator: unknown; text: string }>
    }
    if (typeof evidenceId !== 'string' || !Array.isArray(chunks)) return []
    return chunks.map((chunk) => ({ evidenceId, locator: chunk.locator, text: chunk.text }))
  })
}

/** The files the notes of the document name: what the text may have to read. */
const namedFiles = (slot: SlotRequest): string[] =>
  (slot.documento?.note ?? []).flatMap((note) =>
    note.fonte && FILE_NAME.test(note.fonte) ? [note.fonte] : [],
  )

/**
 * The lines of the documents read that speak of what the text is about, quoted as they are with
 * the place they stand at; none when the text has no topic the fake model knows.
 */
function quotedPassages(slot: SlotRequest, request: ModelRequest, maxChars: number) {
  const id = slot.testo_da_scrivere?.id ?? ''
  const topic = SLOT_TOPICS.find(([slotWord]) => slotWord.test(id))?.[1]
  if (!topic) return []
  const quotes: Array<{ text: string; source: { evidenceId: string; locator: unknown } }> = []
  let length = 0
  for (const passage of passagesRead(request)) {
    const line = passage.text
      .split('\n')
      .find((candidate) => topic.test(candidate.trim()))
      ?.trim()
    if (!line || quotes.length === MAX_SLOT_SENTENCES || length + line.length + 1 > maxChars)
      continue
    quotes.push({
      text: line,
      source: { evidenceId: passage.evidenceId, locator: passage.locator },
    })
    length += line.length + 1
  }
  return quotes
}

/** Whether the text asked for is the first one the document has. */
function isFirstText(slot: SlotRequest): boolean {
  const blocks = (slot.documento?.sezioni ?? []).flatMap((section) => section.blocchi ?? [])
  return (
    blocks.find((block) => block.tipo === 'testo_da_scrivere')?.id === slot.testo_da_scrivere?.id
  )
}

/**
 * A text of a document, written only with values the document already holds, each quoted as it
 * is and citing its note: nothing the checks could find unsupported. When the PM asked for a
 * change the text quotes the following values instead: enough to see a revision replace a text.
 */
function slotText(request: ModelRequest, options: FakeRunnerOptions): unknown {
  const slot = slotRequestOf(request)
  const maxChars = slot.testo_da_scrivere?.massimo_caratteri ?? DEFAULT_SLOT_CHARS
  const natures = slot.testo_da_scrivere?.nature_ammesse ?? ['fact']
  const nature = natures.includes('fact') ? 'fact' : (natures[0] ?? 'fact')
  // A text about a document the notes name is written from what was read of that document: its
  // own lines, each with its place, or nothing when the document does not say.
  if (namedFiles(slot).length > 0) {
    return {
      lang: 'it',
      segments: quotedPassages(slot, request, maxChars).map((quote) => ({
        text: quote.text,
        nature,
        sources: [quote.source],
      })),
      absences: [],
      internalNotes: [],
    }
  }
  const values = quotableValues(slot)
  const from = slot.richiesta_del_pm && values.length > 1 ? 1 : 0
  const segments: Array<{ text: string; nature: string; sources: Array<{ note: number }> }> = []
  const invented = INVENTED_SENTENCE.trim()
  const invents = options.inventInDrafts === true && !slot.richiesta_del_pm && isFirstText(slot)
  // The invented figure takes its room first: the text never passes its limit.
  let length = invents ? invented.length + 1 : 0
  for (const value of [...values.slice(from), ...values.slice(0, from)]) {
    const text = `${value.label}: ${value.text.replace(/[.!?]+$/u, '')}.`
    if (segments.length === MAX_SLOT_SENTENCES || length + text.length + 1 > maxChars) continue
    segments.push({ text, nature, sources: value.notes.map((note) => ({ note })) })
    length += text.length + 1
  }
  if (invents) segments.push({ text: invented, nature, sources: [] })
  const absences =
    segments.length > 0
      ? []
      : [
          {
            question: 'Quali informazioni deve riportare questo testo?',
            proposal: 'Indica i fatti da comunicare nei parametri del documento.',
          },
        ]
  return { lang: 'it', segments, absences, internalNotes: [] }
}

/** What the fake model answers, by the name of the response schema of the request. */
const SKILLS: Readonly<
  Record<string, (request: ModelRequest, options: FakeRunnerOptions) => unknown>
> = {
  compiled_facts: (request) => {
    const data = request.messages.find((message) => message.role === 'user')
    return data?.content ? compiledFacts(data.content) : {}
  },
  project_answer: projectAnswer,
  slot_text: slotText,
  // The fake reviewer finds nothing: the deterministic gates do the checking.
  draft_review: () => ({ findings: [] }),
}

function answer(request: ModelRequest, options: FakeRunnerOptions): string {
  const skill = SKILLS[request.responseSchema?.name ?? '']
  return JSON.stringify(skill ? skill(request, options) : {})
}

const READING_DONE: ModelResponse = {
  message: { role: 'assistant', content: 'Lettura completata.' },
  finishReason: 'stop',
  usage: { inputTokens: 0, outputTokens: 0 },
  backend: FAKE_BACKEND,
}

const callTool = (name: string, args: Record<string, unknown>): ModelResponse => ({
  message: {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: `${name}-${JSON.stringify(args).length}`, name, arguments: args }],
  },
  finishReason: 'tool_calls',
  usage: { inputTokens: 0, outputTokens: 0 },
  backend: FAKE_BACKEND,
})

/**
 * The reading of a text of a recipe, as an agent with few tools does it: when the notes of the
 * document name a file, the fake model searches the project with the instructions of the text,
 * reads the document named among what it found and stops. A text that names no file needs no
 * reading.
 */
function slotToolTurn(request: ModelRequest, slot: SlotRequest): ModelResponse {
  const offered = (name: string) => request.tools?.some((tool) => tool.name === name) === true
  const files = namedFiles(slot)
  if (files.length === 0) return READING_DONE
  const found = toolResults(request).find((result) => Array.isArray(result.results)) as
    | { results: ReadHit[] }
    | undefined
  if (!found) {
    const query = slot.testo_da_scrivere?.istruzioni ?? files.join(' ')
    return offered(SEARCH_TOOL) ? callTool(SEARCH_TOOL, { query }) : READING_DONE
  }
  const named = found.results.find((hit) => hit.evidence_id && files.includes(hit.title))
  // Asked for once: a document without text gives no passage and is not asked for again.
  const asked = request.messages.some(
    (message) =>
      message.role === 'assistant' && message.toolCalls?.some((call) => call.name === READ_TOOL),
  )
  return named && !asked && offered(READ_TOOL)
    ? callTool(READ_TOOL, { evidence_id: named.evidence_id })
    : READING_DONE
}

/**
 * A turn with tools: the fake model searches once with the question, then says it has read
 * enough. Only the search tool, only when it is offered.
 */
function toolTurn(request: ModelRequest): ModelResponse {
  const slot = slotRequestOf(request)
  if (slot.testo_da_scrivere) return slotToolTurn(request, slot)
  const searched = request.messages.some((message) => message.role === 'tool')
  // Only a question is searched for: the writer of a recipe already has its data.
  const canSearch =
    questionOf(request) !== '' && request.tools?.some((tool) => tool.name === SEARCH_TOOL) === true
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
  /**
   * Makes the first text of a first draft carry a figure no source holds: the way to see,
   * without a real model, an anomaly found, a change asked and the anomaly gone.
   */
  readonly inventInDrafts?: boolean | undefined
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
        message: { role: 'assistant', content: answer(request, options) },
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
