import type { DocumentKind } from './classification.ts'
import type { DateSource } from './document-date.ts'
import type { FreshnessPolicy } from './freshness.ts'
import type { SourceKind as ConnectedSourceKind } from './source.ts'

/** Where a document comes from: one of the sources of the project, or the manual upload. */
export type SourceKind = ConnectedSourceKind | 'manual_upload'

/** Who gave the date of a document: the PM, the source system, or nobody (the acquisition). */
export const ORIGIN_SOURCES = ['pm', 'acquisition', 'system'] as const
export type OriginSource = (typeof ORIGIN_SOURCES)[number]

/** Connectors that carry the live data of a system; Teams, mail and SharePoint carry documents. */
const SYSTEM_SOURCE_KINDS: readonly SourceKind[] = ['ado', 'jira', 'dwsi']
/** Kinds of document that are an export of a system, whoever uploaded them. */
const SYSTEM_DOCUMENT_KINDS: readonly DocumentKind[] = [
  'backlog_export',
  'timesheet',
  'economics_export',
]
/** A kind that says nothing of what the document is: two of them are not «the same type». */
const UNTYPED: DocumentKind = 'generic'
/**
 * Kinds of document that record one event each (a meeting, an order, an invoice): a later one is
 * another event, never a newer version of an earlier one, so it supersedes nothing. A status
 * report, a plan or a contract has versions, and the latest supersedes the older ones.
 */
export const EVENT_DOCUMENT_KINDS: readonly DocumentKind[] = [
  'transcript',
  'meeting_minutes',
  'purchase_order',
  'invoice',
]

/** Whether a newer document of this kind makes an older one of it superseded. */
export function hasVersions(kind: DocumentKind): boolean {
  return kind !== UNTYPED && !EVENT_DOCUMENT_KINDS.includes(kind)
}

/** How the age of a source is judged, from where it came and what its current kind is. */
export function freshnessPolicyOf(
  sourceKind: SourceKind,
  documentKind: DocumentKind | null,
): FreshnessPolicy {
  if (SYSTEM_SOURCE_KINDS.includes(sourceKind)) return 'system'
  if (documentKind !== null && SYSTEM_DOCUMENT_KINDS.includes(documentKind)) return 'system'
  return 'document'
}

/**
 * Whether a piece of evidence is system data its system did not date: a connector of a system
 * read it and the system gave no date, nor did the PM. Its age is not deduced (unknown), never
 * the time of the read nor a date guessed from its title. An upload, or what a document
 * connector read, is dated as any document.
 */
export function systemLeftUndated(e: {
  sourceKind: SourceKind
  originSource: OriginSource
  dateSource: DateSource
}): boolean {
  return (
    SYSTEM_SOURCE_KINDS.includes(e.sourceKind) &&
    e.originSource === 'acquisition' &&
    e.dateSource !== 'pm'
  )
}

/** The freshness policy of a source, and whether a newer document of its kind exists. */
export interface SourcePolicy {
  freshnessPolicy: FreshnessPolicy
  /** A document of the same kind with a later registered date is in the project. */
  superseded: boolean
}

/** A piece of evidence of a project as the policy needs it: origin, current kind, registered date. */
export interface PolicyInput<Id extends string = string> {
  id: Id
  sourceKind: SourceKind
  /** `null` while the evidence has no classification. */
  documentKind: DocumentKind | null
  date: Date
}

/**
 * The policy of every piece of evidence of a project. A document is superseded when the project
 * holds a document of the same (typed) kind with a later registered date, for the kinds that have
 * versions (`hasVersions`): a meeting is never superseded by the next one. System data never is,
 * since its age already says how current it is.
 */
export function sourcePolicies<Id extends string>(
  all: readonly PolicyInput<Id>[],
): Map<Id, SourcePolicy> {
  const latest = new Map<DocumentKind, number>()
  for (const e of all) {
    if (e.documentKind === null) continue
    latest.set(e.documentKind, Math.max(latest.get(e.documentKind) ?? -Infinity, e.date.getTime()))
  }
  const out = new Map<Id, SourcePolicy>()
  for (const e of all) {
    const freshnessPolicy = freshnessPolicyOf(e.sourceKind, e.documentKind)
    const superseded =
      freshnessPolicy === 'document' &&
      e.documentKind !== null &&
      hasVersions(e.documentKind) &&
      (latest.get(e.documentKind) ?? -Infinity) > e.date.getTime()
    out.set(e.id, { freshnessPolicy, superseded })
  }
  return out
}

/**
 * The policy of a fact: a fact stated by the PM is a document of the PM; otherwise it is system
 * data when any of its sources is, and superseded only when every source of it is.
 */
export function factPolicy(sources: readonly SourcePolicy[], pmAsserted: boolean): SourcePolicy {
  if (pmAsserted) return { freshnessPolicy: 'document', superseded: false }
  if (sources.some((s) => s.freshnessPolicy === 'system')) {
    return { freshnessPolicy: 'system', superseded: false }
  }
  return {
    freshnessPolicy: 'document',
    superseded: sources.length > 0 && sources.every((s) => s.superseded),
  }
}
