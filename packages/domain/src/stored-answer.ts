import { type AnswerSourceRef, NATURES, type Nature } from './answer.ts'
import {
  ANSWER_ANOMALY_CODES,
  type AnswerAnomaly,
  type FreshnessWarning,
  type SegmentFreshness,
  type SuspendedReason,
  type UnverifiedReason,
  type VerifiedAbsence,
  type VerifiedAnswer,
  type VerifiedContradiction,
  type VerifiedSegment,
  type VerifiedSide,
  type VerifiedSource,
} from './answer-check.ts'
import { DATE_SOURCES } from './document-date.ts'
import { DomainError } from './errors.ts'
import { isLocator, type Locator } from './extraction.ts'
import {
  FRESHNESS_POLICIES,
  type FreshnessLevel,
  type FreshnessPolicy,
  type SourceFreshnessLevel,
} from './freshness.ts'
import type { EvidenceId, FactId, SourceId } from './ids.ts'
import { LANGS, type Lang } from './language/index.ts'
import { DATA_KINDS, type DataKind } from './numbers.ts'
import { canonicalTrackerLocator, isTrackerLocator } from './tracker.ts'

// A verified answer is stored as JSON (dates as ISO strings). Before it is shown it is read back
// here: shapes, enumerations and the invariants of `verifyAnswer` are checked, so a stored value
// can never show a suspended text or a source without its registered title and date.

const LEVELS: readonly FreshnessLevel[] = ['fresh', 'warning', 'stale']
const SOURCE_LEVELS: readonly SourceFreshnessLevel[] = [...LEVELS, 'dated']
const SEGMENT_FRESHNESS: readonly SegmentFreshness[] = [...SOURCE_LEVELS, 'unknown']
const WARNINGS: readonly FreshnessWarning[] = ['to_recheck', 'stale', 'superseded']
const SUSPENDED: readonly SuspendedReason[] = ['without_source', 'stale_data', 'unknown_freshness']
const UNVERIFIED: readonly UnverifiedReason[] = [
  'not_read',
  'unknown_source',
  'numbers_not_in_source',
]
const ID_MAX = 100

function invalid(): never {
  throw new DomainError('stored_value_invalid')
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) invalid()
  return v as Record<string, unknown>
}

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) invalid()
  return v
}

function str(v: unknown): string {
  if (typeof v !== 'string') invalid()
  return v
}

function strOrNull(v: unknown): string | null {
  return v === null ? null : str(v)
}

function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') invalid()
  return v
}

function count(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) invalid()
  return v
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) invalid()
  return v as T
}

function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return v === null ? null : oneOf(v, allowed)
}

function date(v: unknown): Date {
  const d = new Date(str(v))
  if (Number.isNaN(d.getTime())) invalid()
  return d
}

function id(v: unknown): string {
  const s = str(v)
  if (s.trim() === '' || s.length > ID_MAX) invalid()
  return s
}

function ref(v: unknown): AnswerSourceRef {
  const r = obj(v)
  const keys = Object.keys(r).sort().join(',')
  if (keys === 'factId') return { factId: id(r.factId) as FactId }
  if (keys === 'evidenceId,locator' && isLocator(r.locator)) {
    return { evidenceId: id(r.evidenceId) as EvidenceId, locator: { ...(r.locator as Locator) } }
  }
  if (keys === 'locator,sourceId' && isTrackerLocator(r.locator)) {
    return { sourceId: id(r.sourceId) as SourceId, locator: canonicalTrackerLocator(r.locator) }
  }
  invalid()
}

function source(v: unknown): VerifiedSource {
  const s = obj(v)
  const verified = bool(s.verified)
  const reason = oneOfOrNull(s.reason, UNVERIFIED)
  const title = strOrNull(s.title)
  const sourceDate = s.sourceDate === null ? null : date(s.sourceDate)
  const freshness =
    s.freshness === null
      ? null
      : (() => {
          const f = obj(s.freshness)
          const ageHours = f.ageHours
          if (typeof ageHours !== 'number' || !Number.isFinite(ageHours) || ageHours < 0) invalid()
          return { level: oneOf(f.level, SOURCE_LEVELS), ageHours }
        })()
  // Answers stored before the policy existed judged every source by the thresholds.
  const freshnessPolicy: FreshnessPolicy =
    s.freshnessPolicy === undefined ? 'system' : oneOf(s.freshnessPolicy, FRESHNESS_POLICIES)
  const superseded = s.superseded === undefined ? false : bool(s.superseded)
  // A document is only dated, system data only judged; only a document can be superseded.
  if (freshness && (freshness.level === 'dated') !== (freshnessPolicy === 'document')) invalid()
  if (superseded && freshnessPolicy !== 'document') invalid()
  if (verified !== (reason === null)) invalid()
  const cited = ref(s.ref)
  // Only system data (a tracker, an extraction its system did not date) may be of unknown age;
  // a verified document is always dated.
  const unknownAge = sourceDate === null && freshnessPolicy === 'system'
  if (verified && (title === null || (sourceDate === null && !unknownAge))) invalid()
  if (freshness && !verified) invalid()
  const futureDate = bool(s.futureDate)
  // A verified source with a plausible date always has its freshness (`verifyAnswer`).
  if (verified && !futureDate && sourceDate !== null && freshness === null) invalid()
  if ((futureDate || sourceDate === null) && freshness !== null) invalid()
  return {
    ref: cited,
    verified,
    reason,
    title,
    sourceDate,
    dateSource: oneOfOrNull(s.dateSource, DATE_SOURCES),
    pmAsserted: bool(s.pmAsserted),
    // Answers stored before the mark existed have no contested source.
    contested: s.contested === undefined ? false : bool(s.contested),
    futureDate,
    freshnessPolicy,
    superseded,
    freshness,
  }
}

/** A text is shown exactly when it is not suspended. */
function shown(text: string | null, suspendedReason: SuspendedReason | null): void {
  if ((text === null) !== (suspendedReason !== null)) invalid()
}

function segment(v: unknown): VerifiedSegment {
  const s = obj(v)
  const text = strOrNull(s.text)
  const suspendedReason = oneOfOrNull(s.suspendedReason, SUSPENDED)
  const withoutSource = bool(s.withoutSource)
  const numbersSuspended = bool(s.numbersSuspended)
  shown(text, suspendedReason)
  if (withoutSource !== (suspendedReason === 'without_source')) invalid()
  if (numbersSuspended !== (suspendedReason !== null)) invalid()
  return {
    text,
    originalText: str(s.originalText),
    nature: oneOf<Nature>(s.nature, NATURES),
    sources: arr(s.sources).map(source),
    inScope: bool(s.inScope),
    dataKinds: arr(s.dataKinds).map((k) => oneOf<DataKind>(k, DATA_KINDS)),
    mentionsKnownName: bool(s.mentionsKnownName),
    mixedScript: bool(s.mixedScript),
    withoutSource,
    freshness: oneOf(s.freshness, SEGMENT_FRESHNESS),
    warning: oneOfOrNull(s.warning, WARNINGS),
    contested: s.contested === undefined ? false : bool(s.contested),
    numbersSuspended,
    suspendedReason,
  }
}

function side(v: unknown): VerifiedSide {
  const s = obj(v)
  const value = strOrNull(s.value)
  const suspendedReason = oneOfOrNull(s.suspendedReason, SUSPENDED)
  shown(value, suspendedReason)
  const src = source(s.source)
  if (!src.verified && suspendedReason !== 'without_source') invalid()
  return {
    value,
    originalValue: str(s.originalValue),
    source: src,
    freshness: oneOf(s.freshness, SEGMENT_FRESHNESS),
    warning: oneOfOrNull(s.warning, WARNINGS),
    suspendedReason,
  }
}

function contradiction(v: unknown): VerifiedContradiction {
  const c = obj(v)
  const subject = strOrNull(c.subject)
  const reason = strOrNull(c.reason)
  const suppressed = bool(c.suppressed)
  if ((subject === null) !== suppressed || (reason === null) !== suppressed) invalid()
  const sides = arr(c.sides).map(side)
  const allSidesVerified = bool(c.allSidesVerified)
  if (allSidesVerified !== sides.every((s) => s.source.verified)) invalid()
  return {
    subject,
    reason,
    originalSubject: str(c.originalSubject),
    originalReason: str(c.originalReason),
    suppressed,
    sides,
    allSidesVerified,
    sameDocument: bool(c.sameDocument),
  }
}

function absence(v: unknown): VerifiedAbsence {
  const a = obj(v)
  const question = strOrNull(a.question)
  const proposal = strOrNull(a.proposal)
  const suppressed = bool(a.suppressed)
  if ((question === null) !== suppressed || (proposal === null) !== suppressed) invalid()
  return {
    question,
    proposal,
    originalQuestion: str(a.originalQuestion),
    originalProposal: str(a.originalProposal),
    suppressed,
  }
}

function anomaly(v: unknown): AnswerAnomaly {
  const a = obj(v)
  const out: AnswerAnomaly = { code: oneOf(a.code, ANSWER_ANOMALY_CODES), index: count(a.index) }
  if (a.side !== undefined) out.side = count(a.side)
  return out
}

/**
 * Reads back a verified answer stored as JSON. Anything that is not exactly what `verifyAnswer`
 * produces (unknown values, a suspended text present, a verified source without title or date,
 * counts of checks that do not add up) raises `stored_value_invalid`; unknown fields are dropped.
 */
export function rehydrateVerifiedAnswer(value: unknown): VerifiedAnswer {
  const v = obj(value)
  const checks = obj(v.checks)
  const list = arr(checks.list).map(anomaly)
  const anomalies = count(checks.anomalies)
  if (anomalies !== list.length) invalid()
  return {
    lang: oneOf<Lang>(v.lang, LANGS),
    segments: arr(v.segments).map(segment),
    contradictions: arr(v.contradictions).map(contradiction),
    absences: arr(v.absences).map(absence),
    checks: { total: count(checks.total, 1), anomalies, list },
  }
}
