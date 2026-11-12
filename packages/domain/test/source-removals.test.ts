import { describe, expect, it } from 'vitest'
import {
  type AnswerSourceRef,
  citedIdsOf,
  type EvidenceId,
  type FactId,
  factSourceRemoved,
  type Locator,
  removedSinceAnswer,
  type SourceId,
  standingSources,
  type VerifiedAnswer,
  type VerifiedSource,
} from '../src/recipe/index.ts'

const MAIL = '0b9c3d43-5a0e-4c39-9a51-6f3b9b0c1a11' as EvidenceId
const MINUTES = '1c9c3d43-5a0e-4c39-9a51-6f3b9b0c1a12' as EvidenceId
const FACT = '2d9c3d43-5a0e-4c39-9a51-6f3b9b0c1a13' as FactId
const TRACKER = '3e9c3d43-5a0e-4c39-9a51-6f3b9b0c1a14' as SourceId
const PAGE: Locator = { kind: 'page', page: 1 }
const removed = new Set<EvidenceId>([MAIL])
const isRemoved = (id: EvidenceId) => removed.has(id)
const source = (evidenceId: EvidenceId) => ({ evidenceId, locator: PAGE, excerpt: 'testo' })

describe('evidence removed at the source in the knowledge', () => {
  it('marks a fact whose every source was removed as «fonte rimossa»', () => {
    expect(factSourceRemoved({ pmAsserted: false, sources: [source(MAIL)] }, isRemoved)).toBe(true)
  })

  it('keeps a fact that still has a source standing, which loses only the removed one', () => {
    const fact = { pmAsserted: false, sources: [source(MAIL), source(MINUTES)] }
    expect(factSourceRemoved(fact, isRemoved)).toBe(false)
    expect(standingSources(fact.sources, isRemoved).map((s) => s.evidenceId)).toEqual([MINUTES])
  })

  it('never suspends what the PM stated: the correction of the PM wins', () => {
    expect(factSourceRemoved({ pmAsserted: true, sources: [source(MAIL)] }, isRemoved)).toBe(false)
  })

  it('does not call removed a fact that never had a source', () => {
    expect(factSourceRemoved({ pmAsserted: false, sources: [] }, isRemoved)).toBe(false)
  })
})

function verified(ref: AnswerSourceRef, ok = true): VerifiedSource {
  return {
    ref,
    verified: ok,
    reason: ok ? null : 'unknown_source',
    title: ok ? 'Mail' : null,
    sourceDate: null,
    dateSource: null,
    pmAsserted: false,
    contested: false,
    futureDate: false,
    freshnessPolicy: 'document',
    superseded: false,
    freshness: null,
  }
}

const answer = (segmentSources: VerifiedSource[], sideSources: VerifiedSource[]) =>
  ({
    lang: 'it',
    segments: [{ text: 'Testo', sources: segmentSources }],
    contradictions: [
      { sides: sideSources.map((s) => ({ value: 'x', originalValue: 'x', source: s })) },
    ],
    absences: [],
    checks: { total: 1, anomalies: 0, list: [] },
  }) as unknown as VerifiedAnswer

describe('the sources of a stored answer removed since', () => {
  it('lists the evidence and the facts a stored answer cites, verified ones only, once each', () => {
    const a = answer(
      [
        verified({ evidenceId: MAIL, locator: PAGE }),
        verified({ evidenceId: MINUTES, locator: PAGE }, false),
        verified({ sourceId: TRACKER, locator: { kind: 'tracker', query: 'q' } as never }),
      ],
      [verified({ factId: FACT }), verified({ evidenceId: MAIL, locator: PAGE })],
    )
    expect(citedIdsOf(a)).toEqual({ evidence: [MAIL], facts: [FACT] })
  })

  it('says which cited source was removed since the answer, and none otherwise', () => {
    const gone = { evidence: new Set([MAIL]), facts: new Set([FACT]) }
    expect(removedSinceAnswer({ evidenceId: MAIL, locator: PAGE }, gone)).toBe(true)
    expect(removedSinceAnswer({ factId: FACT }, gone)).toBe(true)
    expect(removedSinceAnswer({ evidenceId: MINUTES, locator: PAGE }, gone)).toBe(false)
    expect(
      removedSinceAnswer({ sourceId: TRACKER, locator: { kind: 'tracker' } as never }, gone),
    ).toBe(false)
  })
})
