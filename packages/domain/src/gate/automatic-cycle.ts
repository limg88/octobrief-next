import type { Lang } from '../language/index.ts'
import type { DeliverableDocument } from '../recipe/document-model.ts'
import { canonicalJson } from '../recipe/hash.ts'
import type { Acceptance } from './acceptance.ts'
import type { PmDecision } from './decisions.ts'
import { dataHash, skeletonHash } from './fingerprints.ts'
import { anomaliesOfRows, type RedTeamRow } from './red-team.ts'

// The one automatic cycle of a run. It runs at most once, only when every open anomaly is a
// matter of form, and it rewrites only the text slots those anomalies are in. Its revision is
// kept only if the skeleton and the data stay the same (`skeletonHash`, `dataHash`), nothing
// outside those slots changed and no anomaly other than of form appeared; otherwise it is
// discarded and the previous revision stands, with every anomaly it had. Data and structure are
// never fixed automatically.

export type RevisionOrigin = 'writer' | 'automatic_cycle' | 'pm_request'

export type CycleRefusal =
  /** A cycle already ran in this run. */
  | 'already_ran'
  /** The latest revision is a request of the PM: the PM is in charge of the draft. */
  | 'after_pm_request'
  | 'nothing_open'
  /** An anomaly of data or structure is open: never fixed automatically. */
  | 'data_or_structure_open'
  /** The anomalies of form are outside the text slots (titles, cells). */
  | 'nothing_in_slots'

export type CyclePlan = { run: true; slots: string[] } | { run: false; reason: CycleRefusal }

/** Whether the automatic cycle runs on a revision, and on which text slots. */
export function planAutomaticCycle(input: {
  rows: readonly RedTeamRow[]
  acceptances: readonly Acceptance[]
  decisions: readonly PmDecision[]
  /** The origins of the revisions of the run so far, in order. */
  revisions: readonly RevisionOrigin[]
}): CyclePlan {
  if (input.revisions.includes('automatic_cycle')) return { run: false, reason: 'already_ran' }
  if (input.revisions.at(-1) === 'pm_request') return { run: false, reason: 'after_pm_request' }
  const open = anomaliesOfRows(input.rows, input.acceptances, input.decisions).filter(
    (a) => a.status === 'open',
  )
  if (open.length === 0) return { run: false, reason: 'nothing_open' }
  if (open.some((a) => a.class !== 'form')) return { run: false, reason: 'data_or_structure_open' }
  const slots = [...new Set(open.flatMap((a) => (a.slot === null ? [] : [a.slot])))].sort()
  if (slots.length === 0) return { run: false, reason: 'nothing_in_slots' }
  return { run: true, slots }
}

export type RevisionVerdict =
  | { keep: true }
  | {
      keep: false
      reason: 'skeleton_changed' | 'data_changed' | 'outside_slots' | 'anomaly_added'
    }

interface Revision {
  document: DeliverableDocument
  rows: readonly RedTeamRow[]
}

/**
 * The whole draft with only the segments of the planned text blocks left out: titles, fixed
 * texts, tables, values, the other slots, the notes for the PM, the source notes and the header
 * all stay in, so any change outside the plan is seen.
 */
function outsideSlots(doc: DeliverableDocument, slots: ReadonlySet<string>): string {
  return canonicalJson({
    ...doc,
    sections: doc.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map((b) =>
        b.kind === 'text' && slots.has(b.id) ? { ...b, segments: null } : b,
      ),
    })),
  })
}

/**
 * Whether the revision of the automatic cycle is kept: the same skeleton and data as before,
 * nothing changed outside the segments of the planned slots, and no open anomaly but of form (the
 * plan ran only when there was none, so any is new, an accepted one whose content changed too).
 */
export function judgeAutomaticRevision(input: {
  before: Revision
  after: Revision
  plan: { slots: readonly string[] }
  lang: Lang
  knownNames: readonly string[]
  acceptances: readonly Acceptance[]
  decisions: readonly PmDecision[]
}): RevisionVerdict {
  const { before, after } = input
  if (skeletonHash(before.document) !== skeletonHash(after.document)) {
    return { keep: false, reason: 'skeleton_changed' }
  }
  if (
    dataHash(before.document, input.lang, input.knownNames) !==
    dataHash(after.document, input.lang, input.knownNames)
  ) {
    return { keep: false, reason: 'data_changed' }
  }
  const slots = new Set(input.plan.slots)
  if (outsideSlots(before.document, slots) !== outsideSlots(after.document, slots)) {
    return { keep: false, reason: 'outside_slots' }
  }
  const added = anomaliesOfRows(after.rows, input.acceptances, input.decisions).some(
    (a) => a.class !== 'form' && a.status === 'open',
  )
  if (added) return { keep: false, reason: 'anomaly_added' }
  return { keep: true }
}
