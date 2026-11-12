import { DomainError } from './errors.ts'

export interface FreshnessThresholds {
  warnAfterHours: number
  stopAfterHours: number
}

export const DEFAULT_FRESHNESS: FreshnessThresholds = Object.freeze({
  warnAfterHours: 24,
  stopAfterHours: 72,
})

export type FreshnessLevel = 'fresh' | 'warning' | 'stale'

const HOUR_MS = 3_600_000

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0
}

/** Validates thresholds: positive integers, warn < stop, never looser than the defaults. */
export function tightenFreshness(t: FreshnessThresholds): FreshnessThresholds {
  if (!isPositiveInt(t.warnAfterHours) || !isPositiveInt(t.stopAfterHours)) {
    throw new DomainError('freshness_invalid')
  }
  if (t.warnAfterHours >= t.stopAfterHours) {
    throw new DomainError('freshness_warn_after_stop')
  }
  if (
    t.warnAfterHours > DEFAULT_FRESHNESS.warnAfterHours ||
    t.stopAfterHours > DEFAULT_FRESHNESS.stopAfterHours
  ) {
    throw new DomainError('freshness_looser_than_default')
  }
  return { warnAfterHours: t.warnAfterHours, stopAfterHours: t.stopAfterHours }
}

export function freshnessOf(
  dataTime: Date,
  now: Date,
  t: FreshnessThresholds,
): { level: FreshnessLevel; ageHours: number } {
  const ageMs = Math.max(0, now.getTime() - dataTime.getTime())
  const ageHours = ageMs / HOUR_MS
  if (ageMs <= t.warnAfterHours * HOUR_MS) return { level: 'fresh', ageHours }
  if (ageMs <= t.stopAfterHours * HOUR_MS) return { level: 'warning', ageHours }
  return { level: 'stale', ageHours }
}

/**
 * How the age of a source is judged. `system` data (a system connector, or the export of a
 * system) is judged by the thresholds; a `document` (a report, minutes, a contract…) is only
 * dated: its age is shown, never a warning, and its numbers are never suspended for age.
 */
export const FRESHNESS_POLICIES = ['system', 'document'] as const
export type FreshnessPolicy = (typeof FRESHNESS_POLICIES)[number]

/** `dated`: the age of a document, shown without any judgement. */
export type SourceFreshnessLevel = FreshnessLevel | 'dated'

export function sourceFreshnessOf(
  dataTime: Date,
  now: Date,
  t: FreshnessThresholds,
  policy: FreshnessPolicy,
): { level: SourceFreshnessLevel; ageHours: number } {
  const judged = freshnessOf(dataTime, now, t)
  return policy === 'system' ? judged : { level: 'dated', ageHours: judged.ageHours }
}
