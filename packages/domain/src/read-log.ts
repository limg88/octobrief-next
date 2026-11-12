import { type Locator, locatorKey } from './extraction.ts'
import type { EvidenceId, FactId, SourceId } from './ids.ts'
import { type TrackerLocator, trackerLocatorKey } from './tracker.ts'

/**
 * One place of a piece of evidence that the model read, with the numbers of the text it was
 * shown there (canonical, as `numbersIn` gives them): a number cited from it must be among them.
 */
export interface EvidenceRead {
  readonly locator: Locator
  readonly numbers: readonly string[]
}

/**
 * One place of a tracker source the model was shown (a work item, a field, the counts of a call),
 * with the numbers shown there and what was shown beside them as names: `labels`, the names of
 * groups («Sprint Alpha»), and `days`, the calendar days (`yyyy-mm-dd`) the counts are as of.
 * Their digits are part of a name, never numbers: a label adds nothing to what was shown.
 */
export interface TrackerRead {
  readonly locator: TrackerLocator
  readonly numbers: readonly string[]
  readonly labels?: readonly string[]
  readonly days?: readonly string[]
}

/** What a model run has read: the base for checking its citations. */
export type ReadLogEntry =
  | { readonly evidenceId: EvidenceId; readonly reads: readonly EvidenceRead[] }
  | { readonly factId: FactId; readonly numbers: readonly string[] }
  | { readonly trackerSourceId: SourceId; readonly reads: readonly TrackerRead[] }

export interface ReadLog {
  readonly entries: ReadonlyArray<ReadLogEntry>
}

export interface ReadLogWriter {
  /** The places read and, for each, the numbers of the text returned to the model. */
  recordEvidence(evidenceId: EvidenceId, reads: readonly EvidenceRead[]): void
  /** A fact read, with the numbers of the text returned to the model (statement and value). */
  recordFact(factId: FactId, numbers: readonly string[]): void
  /** Places of a tracker source shown to the model, with the numbers shown at each. */
  recordTracker(sourceId: SourceId, reads: readonly TrackerRead[]): void
  /** The reads so far, deduplicated and frozen; repeated reads merge their numbers. */
  snapshot(): ReadLog
}

const addAll = (set: Set<string>, numbers: readonly string[]) => {
  for (const n of numbers) set.add(n)
}

type Places<L> = Map<
  string,
  { locator: L; numbers: Set<string>; labels: Set<string>; days: Set<string> }
>

function addPlaces<L extends object>(
  seen: Places<L>,
  reads: ReadonlyArray<{
    locator: L
    numbers: readonly string[]
    labels?: readonly string[]
    days?: readonly string[]
  }>,
  key: (l: L) => string,
): void {
  for (const { locator, numbers, labels, days } of reads) {
    const k = key(locator)
    let place = seen.get(k)
    if (!place) {
      place = {
        locator: Object.freeze({ ...locator }),
        numbers: new Set(),
        labels: new Set(),
        days: new Set(),
      }
      seen.set(k, place)
    }
    addAll(place.numbers, numbers)
    addAll(place.labels, labels ?? [])
    addAll(place.days, days ?? [])
  }
}

function frozenPlaces<L>(places: Places<L> | undefined, withLabels: boolean) {
  return Object.freeze(
    [...(places?.values() ?? [])].map((p) =>
      Object.freeze({
        locator: p.locator,
        numbers: Object.freeze([...p.numbers]),
        ...(withLabels && p.labels.size > 0 ? { labels: Object.freeze([...p.labels]) } : {}),
        ...(withLabels && p.days.size > 0 ? { days: Object.freeze([...p.days]) } : {}),
      }),
    ),
  )
}

/** An in-memory writer: one per run, no I/O. */
export function createReadLog(): ReadLogWriter {
  const evidence = new Map<EvidenceId, Places<Locator>>()
  const facts = new Map<FactId, Set<string>>()
  const trackers = new Map<SourceId, Places<TrackerLocator>>()
  const order: Array<
    { evidenceId: EvidenceId } | { factId: FactId } | { trackerSourceId: SourceId }
  > = []

  return {
    recordEvidence(evidenceId, reads) {
      if (reads.length === 0) return
      let seen = evidence.get(evidenceId)
      if (!seen) {
        seen = new Map()
        evidence.set(evidenceId, seen)
        order.push({ evidenceId })
      }
      addPlaces(seen, reads, locatorKey)
    },
    recordFact(factId, numbers) {
      let seen = facts.get(factId)
      if (!seen) {
        seen = new Set()
        facts.set(factId, seen)
        order.push({ factId })
      }
      addAll(seen, numbers)
    },
    recordTracker(sourceId, reads) {
      if (reads.length === 0) return
      let seen = trackers.get(sourceId)
      if (!seen) {
        seen = new Map()
        trackers.set(sourceId, seen)
        order.push({ trackerSourceId: sourceId })
      }
      addPlaces(seen, reads, trackerLocatorKey)
    },
    snapshot() {
      const entries = order.map((o): ReadLogEntry => {
        if ('factId' in o) {
          return Object.freeze({
            factId: o.factId,
            numbers: Object.freeze([...(facts.get(o.factId) ?? [])]),
          })
        }
        if ('trackerSourceId' in o) {
          return Object.freeze({
            trackerSourceId: o.trackerSourceId,
            reads: frozenPlaces(trackers.get(o.trackerSourceId), true),
          })
        }
        return Object.freeze({
          evidenceId: o.evidenceId,
          reads: frozenPlaces(evidence.get(o.evidenceId), false),
        })
      })
      return Object.freeze({ entries: Object.freeze(entries) })
    },
  }
}
