import {
  applyProposal,
  COMPILE_CHUNKS_PER_CALL,
  COMPILE_MAX_BATCHES,
  COMPILE_SPLIT_CALLS_PER_EVIDENCE,
  detectSuspicious,
  type EvidenceId,
  type Fact,
  type FactId,
  type Lang,
  mergeSources,
  newId,
  normalizeKey,
  normalizeStatement,
  type ProjectId,
  type ProposedFact,
  type User,
  type UserId,
  valuesEqual,
} from '@octobrief/domain'
import {
  COMPILE_LANG,
  type CompileChunk,
  CompileError,
  compileEvidence,
  MAX_EXTRA_CALLS_PER_BATCH,
} from '../knowledge/compile.ts'
import type {
  DocumentToCompile,
  FactRepository,
  FactView,
  KnowledgeChange,
  KnowledgeProgress,
  KnowledgeStore,
} from '../ports/knowledge-store.ts'
import type { Logger } from '../ports/logger.ts'
import {
  EMBEDDING_BATCH_SIZE,
  ModelError,
  type ModelRunner,
  modelErrorCode,
} from '../ports/model-runner.ts'
import { getProject, type ProjectDependencies } from './projects.ts'

/** Stored when the reading fails for a reason that is neither the model's nor the answer's. */
const UNEXPECTED_FAILURE = 'compile_failed'

export interface CompileDependencies {
  readonly knowledge: KnowledgeStore
  /** Already protected: guarded and pseudonymizing (`protectedRunner`). */
  readonly runner: ModelRunner
  readonly logger: Logger
  readonly now?: () => Date
}

/** Whether a fact and a proposal of the same key say the same thing. */
function agrees(fact: Fact, proposal: ProposedFact, lang: Lang): boolean {
  return fact.value === null && proposal.value === null
    ? normalizeStatement(fact.statement) === normalizeStatement(proposal.statement)
    : valuesEqual(fact.value, proposal.value, lang)
}

/**
 * Merges the proposals of one document into the facts of its project. Pure: returns the changes
 * to store. A proposal that agrees with any fact of its key adds its sources there; one that
 * says otherwise is kept beside the fact it contradicts, both contested, never resolved.
 */
export function mergeProposals(
  existing: readonly Fact[],
  proposals: readonly ProposedFact[],
  context: { projectId: ProjectId; now: Date; lang: Lang },
): { changes: KnowledgeChange[]; rejected: number } {
  const facts = [...existing]
  const changes: KnowledgeChange[] = []
  let rejected = 0
  const update = (factId: string, patch: Partial<Fact>) => {
    const at = facts.findIndex((fact) => fact.id === factId)
    if (at >= 0) facts[at] = { ...(facts[at] as Fact), ...patch }
  }
  for (const proposal of proposals) {
    const key = normalizeKey(proposal.key)
    const sameKey = facts.filter((fact) => normalizeKey(fact.key) === key)
    const agreeing = sameKey.find((fact) => agrees(fact, proposal, context.lang))
    const outcome = applyProposal(agreeing ? [agreeing] : facts, proposal, context)
    switch (outcome.kind) {
      case 'insert':
        facts.push(outcome.fact)
        changes.push(outcome)
        break
      case 'add_sources': {
        if (outcome.sources.length === 0) break
        const current = facts.find((fact) => fact.id === outcome.factId) as Fact
        update(outcome.factId, { sources: mergeSources(current.sources, outcome.sources) })
        changes.push(outcome)
        break
      }
      case 'replace':
        update(outcome.factId, {
          statement: outcome.proposed.statement,
          value: outcome.proposed.value,
          sources: outcome.proposed.sources,
          state: 'active',
        })
        changes.push(outcome)
        break
      case 'contradiction':
      case 'possible_contradiction': {
        const fact: Fact = {
          id: newId<FactId>(),
          projectId: context.projectId,
          kind: outcome.proposed.kind,
          key: outcome.proposed.key,
          statement: outcome.proposed.statement,
          value: outcome.proposed.value,
          sources: outcome.proposed.sources,
          origin: 'compile',
          state: 'contested',
          lockedByPm: false,
          pmAsserted: false,
          createdAt: new Date(context.now.getTime()),
        }
        update(outcome.factId, { state: 'contested' })
        facts.push(fact)
        changes.push({ kind: 'contest', factId: outcome.factId, fact })
        break
      }
      default:
        rejected++
    }
  }
  return { changes, rejected }
}

function batchesOf(chunks: readonly CompileChunk[]): CompileChunk[][] {
  const batches: CompileChunk[][] = []
  for (let at = 0; at < chunks.length && batches.length < COMPILE_MAX_BATCHES; ) {
    batches.push(chunks.slice(at, at + COMPILE_CHUNKS_PER_CALL))
    at += COMPILE_CHUNKS_PER_CALL
  }
  return batches
}

async function proposalsOf(
  runner: ModelRunner,
  document: DocumentToCompile,
  chunks: readonly CompileChunk[],
): Promise<{ proposals: ProposedFact[]; calls: number; dropped: number }> {
  const flagged = detectSuspicious(chunks, COMPILE_LANG).length > 0
  const proposals: ProposedFact[] = []
  let calls = 0
  let dropped = 0
  let extraCallsLeft = COMPILE_SPLIT_CALLS_PER_EVIDENCE
  for (const batch of batchesOf(chunks)) {
    const result = await compileEvidence(
      runner,
      {
        projectId: document.projectId as ProjectId,
        evidence: { id: document.id as EvidenceId, title: document.fileName },
        classification: document.classification,
        chunks: batch,
        flagged,
        lang: COMPILE_LANG,
        maxExtraCalls: Math.min(MAX_EXTRA_CALLS_PER_BATCH, extraCallsLeft),
      },
      { userId: document.uploadedBy as UserId },
    )
    extraCallsLeft -= result.extraCalls
    calls += result.attempts
    dropped += Object.values(result.rejected).reduce((sum, count) => sum + count, 0)
    proposals.push(...result.proposals)
  }
  return { proposals, calls, dropped }
}

/** The vectors of every chunk, in blocks; nothing when the runner has no encoder. */
async function embedChunks(
  deps: CompileDependencies,
  document: DocumentToCompile,
): Promise<number> {
  const { runner } = deps
  if (!runner.embed || document.chunks.length === 0) return 0
  const vectors: number[][] = []
  let encoder = runner.embedding
  for (let at = 0; at < document.chunks.length; at += EMBEDDING_BATCH_SIZE) {
    const texts = document.chunks.slice(at, at + EMBEDDING_BATCH_SIZE).map((chunk) => chunk.text)
    const response = await runner.embed({
      texts,
      context: { projectId: document.projectId as ProjectId },
    })
    vectors.push(...response.vectors)
    encoder = { ...response.encoder, backend: response.backend }
  }
  if (!encoder) return 0
  await deps.knowledge.saveEmbeddings(
    document.id,
    { model: encoder.model, digest: encoder.digest },
    vectors,
  )
  return vectors.length
}

function failureCode(error: unknown): string {
  if (error instanceof CompileError) return `compile_${error.code}`
  if (error instanceof ModelError) return modelErrorCode(error)
  return UNEXPECTED_FAILURE
}

/**
 * Worker job: reads a classified document with the model and merges what it says into the
 * knowledge of its project, then stores the vectors of its text. A failure is recorded on the
 * document with a stable code and raised again, so the queue retries it.
 */
export function createCompileDocumentHandler(deps: CompileDependencies) {
  const now = deps.now ?? (() => new Date())
  return async ({ documentId }: { documentId: string }): Promise<void> => {
    const document = await deps.knowledge.compilable(documentId)
    if (!document) return
    try {
      const chunks = document.chunks.map((chunk, ord) => ({ ...chunk, ord }))
      const { proposals, calls, dropped } = await proposalsOf(deps.runner, document, chunks)
      const existing = await deps.knowledge.facts(document.projectId)
      const { changes, rejected } = mergeProposals(existing, proposals, {
        projectId: document.projectId as ProjectId,
        now: now(),
        lang: COMPILE_LANG,
      })
      const embedded = await embedChunks(deps, document)
      await deps.knowledge.saveKnowledge(document.id, changes)
      deps.logger.info('document compiled', {
        documentId,
        calls,
        proposals: proposals.length,
        changes: changes.length,
        dropped: dropped + rejected,
        embedded,
      })
    } catch (error) {
      const code = failureCode(error)
      await deps.knowledge.markKnowledgeFailed(document.id, code)
      deps.logger.error('document compile failed', { documentId, code })
      throw error
    }
  }
}

export interface KnowledgeDependencies extends ProjectDependencies {
  readonly facts: FactRepository
}

/** «Cosa ho capito»: the facts of a project with their sources, and how far the reading is. */
export async function getKnowledge(
  deps: KnowledgeDependencies,
  viewer: User,
  slug: string,
): Promise<{ facts: FactView[]; progress: KnowledgeProgress }> {
  const project = await getProject(deps, viewer, slug)
  const [facts, progress] = await Promise.all([
    deps.facts.list(viewer.id, project.id),
    deps.facts.progress(viewer.id, project.id),
  ])
  return { facts, progress }
}
