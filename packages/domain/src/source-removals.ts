import type { AnswerSourceRef } from './answer.ts'
import type { VerifiedAnswer, VerifiedSource } from './answer-check.ts'
import type { EvidenceId, FactId } from './ids.ts'

// Evidence its source says is gone (a deleted mail, a deleted file) no longer stands for
// anything new: not a passage to read, not a source of a fact, not a citation of a new answer.
// What was built on it stays visible, marked as such, never deleted in silence.

/** Whether a piece of evidence was removed at its source (and did not come back). */
export type IsRemoved = (id: EvidenceId) => boolean

/** The sources of a fact still standing: the removed ones are dropped. */
export function standingSources<Id extends string, T extends { evidenceId: Id }>(
  sources: readonly T[],
  isRemoved: (id: Id) => boolean,
): T[] {
  return sources.filter((s) => !isRemoved(s.evidenceId))
}

/**
 * A fact «fonte rimossa»: it had sources and every one of them was removed at its source. It is
 * shown as such and no longer used (no number without a source); a fact the PM stated is the PM's
 * own source and stays (the correction of the PM wins).
 */
export function factSourceRemoved<Id extends string>(
  fact: { pmAsserted: boolean; sources: readonly { evidenceId: Id }[] },
  isRemoved: (id: Id) => boolean,
): boolean {
  return (
    !fact.pmAsserted &&
    fact.sources.length > 0 &&
    standingSources(fact.sources, isRemoved).length === 0
  )
}

function sourcesOf(answer: VerifiedAnswer): VerifiedSource[] {
  return [
    ...answer.segments.flatMap((s) => s.sources),
    ...answer.contradictions.flatMap((c) => c.sides.map((side) => side.source)),
  ]
}

/** The evidence and the facts a stored answer cites as verified sources, once each. */
export function citedIdsOf(answer: VerifiedAnswer): { evidence: EvidenceId[]; facts: FactId[] } {
  const evidence = new Set<EvidenceId>()
  const facts = new Set<FactId>()
  for (const s of sourcesOf(answer)) {
    if (!s.verified) continue
    if ('evidenceId' in s.ref) evidence.add(s.ref.evidenceId)
    else if ('factId' in s.ref) facts.add(s.ref.factId)
  }
  return { evidence: [...evidence], facts: [...facts] }
}

/** What of a stored answer was removed at the source since it was given. */
export interface RemovedSinceAnswer {
  evidence: ReadonlySet<EvidenceId>
  /** Facts now «fonte rimossa». */
  facts: ReadonlySet<FactId>
}

/** Whether a source a stored answer cites was removed since: the answer stays as it was. */
export function removedSinceAnswer(ref: AnswerSourceRef, removed: RemovedSinceAnswer): boolean {
  if ('evidenceId' in ref) return removed.evidence.has(ref.evidenceId)
  if ('factId' in ref) return removed.facts.has(ref.factId)
  return false
}
