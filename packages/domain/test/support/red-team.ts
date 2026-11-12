// The context of the red-team around the synthetic draft of the sample recipe: every test of the
// red-team changes a copy of it.

import {
  type InternalDocument,
  type RedTeamContext,
  type RedTeamResult,
  runRedTeam,
  skeletonNoteFactId,
  type VerifiedAnswer,
  type VerifiedSource,
} from '../../src/recipe/index.ts'
import { audienceContext, internalDocument, recipeOf } from './client-version.ts'

export const NOW = '2026-11-06T09:30:00.000Z'

type Segment = InternalDocument['internalNotes'][number]
type TextBlock = Extract<InternalDocument['sections'][number]['blocks'][number], { kind: 'text' }>

/**
 * The sample draft with every datum cited and nothing internal in its client part: the red-team
 * finds nothing in it but warnings.
 */
export function cleanDraft(): InternalDocument {
  const doc = internalDocument()
  const text = summaryText(doc)
  const last = text.segments[2] as Segment
  last.sources = [2]
  last.sourceCategories = ['other']
  // The margin of the month is internal: the sample keeps it out of the summary.
  text.segments.splice(1, 1)
  return doc
}

/** The text block of the summary slot of the sample draft. */
export function summaryText(doc: InternalDocument): TextBlock {
  const section = doc.sections.find((s) => s.id === 'summary')
  const block = section?.blocks.find((b) => b.id === 'summary_text')
  if (block?.kind !== 'text') throw new Error('sample draft without its summary')
  return block
}

/** A segment of a text slot. */
export function segment(
  text: string,
  sources: number[] = [],
  nature: Segment['nature'] = 'inference',
): Segment {
  return { text, nature, category: 'other', sources, sourceCategories: sources.map(() => 'other') }
}

/** A note of the draft, cited by the writer and verified. */
export function verifiedNote(n: number): VerifiedSource {
  return {
    ref: { factId: skeletonNoteFactId(n) },
    verified: true,
    reason: null,
    title: `Nota ${n}`,
    sourceDate: new Date(NOW),
    dateSource: 'system',
    pmAsserted: false,
    contested: false,
    futureDate: false,
    freshnessPolicy: 'system',
    superseded: false,
    freshness: { level: 'fresh', ageHours: 0 },
  }
}

/**
 * What the verifier gives for every text slot of a draft when every segment checked out: the
 * red-team refuses a slot the verifier never saw.
 */
export function verifiedSlots(doc: InternalDocument): Record<string, VerifiedAnswer> {
  const out: Record<string, VerifiedAnswer> = {}
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'text') continue
      out[block.id] = {
        lang: 'it',
        segments: block.segments.map((s) => ({
          text: s.text,
          originalText: s.text,
          nature: s.nature,
          // Each cited note as the verifier saw it: the writer cites a note of the draft.
          sources: s.sources.map((n) => verifiedNote(n)),
          inScope: true,
          dataKinds: [],
          mentionsKnownName: false,
          mixedScript: false,
          withoutSource: false,
          freshness: 'fresh',
          warning: null,
          contested: false,
          numbersSuspended: false,
          suspendedReason: null,
        })),
        contradictions: [],
        absences: [],
        checks: { total: 1 + block.segments.length * 3, anomalies: 0, list: [] },
      }
    }
  }
  return out
}

/** The red-team of a draft whose slots the verifier checked as they are, unless told otherwise. */
export function redTeam(
  doc: InternalDocument,
  ctx: RedTeamContext = redTeamContext(),
): RedTeamResult {
  return runRedTeam(doc, {
    ...ctx,
    slotVerifications: { ...verifiedSlots(doc), ...ctx.slotVerifications },
  })
}

export function redTeamContext(over: Partial<RedTeamContext> = {}): RedTeamContext {
  const recipe = over.recipe ?? recipeOf()
  return {
    recipe,
    client: { audience: audienceContext(recipe) },
    lang: 'it',
    parameters: { period: 'ottobre 2026', request_number: '3' },
    periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
    knownNames: [],
    freshness: {
      now: NOW,
      thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
      sourceKinds: { dwsi: 'netsuite_dwsi', ado: 'ado' },
      evidence: { 'ev-dwsi': { policy: 'system', sourceKind: 'manual_upload' } },
      facts: {},
    },
    contestedFacts: [],
    contradictions: [],
    declaredValues: [],
    slotVerifications: {},
    acceptances: [],
    decisions: [],
    suspicious: {},
    ...over,
  }
}
