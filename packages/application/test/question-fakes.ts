import { randomUUID } from 'node:crypto'
import {
  type AnswerStore,
  DEFAULT_FRESHNESS,
  type EvidenceId,
  type KnowledgeReader,
  type Lang,
  type QuestionPhase,
  type RegisteredSource,
  type SearchHit,
  type VerifiedAnswer,
} from '@octobrief/domain'
import type {
  Question,
  QuestionRepository,
  QuestionWorkStore,
} from '../src/ports/question-stores.ts'
import type { AskReading } from '../src/use-cases/questions.ts'
import type { InMemoryDocuments } from './fakes.ts'

/** Both views of the questions; a person sees only their own, on projects they can see. */
export class InMemoryQuestions implements QuestionRepository, QuestionWorkStore {
  readonly rows = new Map<string, Question>()
  private readonly documents: InMemoryDocuments
  private clock = Date.parse('2026-11-12T09:00:00Z')
  constructor(documents: InMemoryDocuments) {
    this.documents = documents
  }
  private patch(questionId: string, change: Partial<Question>) {
    const row = this.rows.get(questionId)
    if (row) this.rows.set(questionId, { ...row, ...change })
  }
  async create(viewerId: string, question: { projectId: string; text: string; lang: Lang }) {
    if (!this.documents.visible(viewerId, question.projectId)) throw new Error('row-level security')
    this.clock += 1000
    const created: Question = {
      id: randomUUID(),
      projectId: question.projectId,
      askedBy: viewerId,
      text: question.text,
      lang: question.lang,
      phase: 'queued',
      answer: null,
      error: null,
      askedAt: new Date(this.clock),
      answeredAt: null,
    }
    this.rows.set(created.id, created)
    return created
  }
  async list(viewerId: string, projectId: string, limit: number) {
    if (!this.documents.visible(viewerId, projectId)) return []
    return [...this.rows.values()]
      .filter((q) => q.projectId === projectId && q.askedBy === viewerId)
      .sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime())
      .slice(0, limit)
  }
  async find(viewerId: string, projectId: string, questionId: string) {
    return (await this.list(viewerId, projectId, Infinity)).find((q) => q.id === questionId) ?? null
  }
  async remove(_viewerId: string, questionId: string) {
    this.rows.delete(questionId)
  }
  async pending(questionId: string) {
    const row = this.rows.get(questionId)
    if (!row || row.phase === 'done' || row.phase === 'failed') return null
    const { id, projectId, askedBy, text, lang } = row
    return { id, projectId, askedBy, text, lang }
  }
  async setPhase(questionId: string, phase: QuestionPhase) {
    this.patch(questionId, { phase })
  }
  async saveAnswer(questionId: string, answer: VerifiedAnswer) {
    this.patch(questionId, { phase: 'done', answer, answeredAt: new Date(this.clock) })
  }
  async saveFailure(questionId: string, code: string) {
    this.patch(questionId, { phase: 'failed', error: code, answeredAt: new Date(this.clock) })
  }
}

/** A project that holds the given passages: what a search returns, registered as documents. */
export function readingOf(hits: readonly SearchHit[]): AskReading<null> {
  const reader: KnowledgeReader<null> = {
    search: async () => [...hits],
    listSources: async () => [],
    readEvidence: async () => null,
    readFact: async () => null,
  }
  const store: AnswerStore<null> = {
    askContext: async () => ({ thresholds: DEFAULT_FRESHNESS, knownNames: [] }),
    async registeredEvidence(_tx, _projectId, ids) {
      const out = new Map<EvidenceId, RegisteredSource>()
      for (const hit of hits) {
        if (!hit.evidenceId || !ids.includes(hit.evidenceId)) continue
        out.set(hit.evidenceId, {
          title: hit.title,
          sourceDate: hit.sourceDate,
          dateSource: hit.dateSource,
          freshnessPolicy: 'document',
          superseded: false,
        })
      }
      return out
    },
    registeredFacts: async () => new Map(),
  }
  return { reader, store, withTx: (fn) => fn(null) }
}
