import { canonicalText } from '../canonical.ts'
import { RED_TEAM_ANOMALY_CODES, type RedTeamAnomalyCode, resolutionOf } from './red-team-model.ts'

// «Accetta così»: the PM accepts one anomaly, with a reason, and the acceptance holds only for
// the content it was given on. Internal data in a client version can be accepted (the PM decides
// what the client sees); credentials and secrets never, and neither can what the code itself
// guarantees (internal notes, internal sections and non-generic source notes never enter a
// client file). Whether an anomaly can be accepted is decided by its code, here, never by a flag
// the anomaly carries.

/** Shortest reason, in characters, the PM gives to accept an anomaly. */
export const MIN_ACCEPTANCE_REASON = 20
/** Fewest letters a reason holds: dots, emoji or invisible characters are no reason. */
export const MIN_ACCEPTANCE_REASON_LETTERS = 10

const GRAPHEMES = new Intl.Segmenter('it', { granularity: 'grapheme' })
const LETTER = /^\p{L}/u

/**
 * Whether a text is a reason: at least `MIN_ACCEPTANCE_REASON` characters as the PM sees them
 * (grapheme clusters of its canonical form, without invisible characters), and at least
 * `MIN_ACCEPTANCE_REASON_LETTERS` of them letters.
 */
export function isAcceptanceReason(reason: string): boolean {
  const graphemes = [...GRAPHEMES.segment(canonicalText(reason))].map((g) => g.segment)
  if (graphemes.length < MIN_ACCEPTANCE_REASON) return false
  return graphemes.filter((g) => LETTER.test(g)).length >= MIN_ACCEPTANCE_REASON_LETTERS
}

/**
 * Whether the PM may accept each anomaly of the red-team: only those whose resolution is an
 * acceptance. Contradictions and changed declared values are decided instead (`decideAnomaly`);
 * credentials, secrets, data without source, structure and what the code itself guarantees
 * (internal notes, internal sections, non-generic source notes) need a new draft.
 */
export const ANOMALY_ACCEPTABILITY: Readonly<Record<RedTeamAnomalyCode, boolean>> = Object.freeze(
  Object.fromEntries(
    RED_TEAM_ANOMALY_CODES.map((code) => [code, resolutionOf(code) === 'acceptance']),
  ) as Record<RedTeamAnomalyCode, boolean>,
)
export type KnownAnomalyCode = RedTeamAnomalyCode

/** Whether the PM may accept an anomaly with this code: an unknown code never. */
export function isAcceptableCode(code: string): boolean {
  return resolutionOf(code) === 'acceptance'
}

/** What identifies an anomaly for an acceptance: its code, its place and its content. */
export interface AcceptableAnomaly {
  code: string
  /** Canonical key of the place of the anomaly in the document. */
  refKey: string
  /** Fingerprint of the content the anomaly is about. */
  contentHash: string
}

export interface Acceptance {
  code: string
  refKey: string
  contentHash: string
  reason: string
  /** Who accepted. */
  by: string
  /** ISO instant. */
  at: string
}

export type AcceptanceRefusal = 'not_acceptable' | 'reason_too_short'

export type AcceptanceResult =
  | { ok: true; acceptance: Acceptance }
  | { ok: false; refusal: AcceptanceRefusal }

/** Accepts one anomaly, with a reason (`isAcceptanceReason`), kept in its canonical form. */
export function acceptAnomaly(
  anomaly: AcceptableAnomaly,
  input: { reason: string; by: string; at: string },
): AcceptanceResult {
  if (!isAcceptableCode(anomaly.code)) return { ok: false, refusal: 'not_acceptable' }
  const reason = canonicalText(input.reason)
  if (!isAcceptanceReason(reason)) return { ok: false, refusal: 'reason_too_short' }
  return {
    ok: true,
    acceptance: {
      code: anomaly.code,
      refKey: anomaly.refKey,
      contentHash: anomaly.contentHash,
      reason,
      by: input.by,
      at: input.at,
    },
  }
}

/**
 * Whether an anomaly is accepted: an acceptance with its code, its place and the fingerprint of
 * the same content, and a code that can be accepted at all.
 */
export function isAccepted(
  anomaly: AcceptableAnomaly,
  acceptances: readonly Acceptance[],
): boolean {
  if (!isAcceptableCode(anomaly.code)) return false
  return acceptances.some(
    (a) =>
      a.code === anomaly.code &&
      a.refKey === anomaly.refKey &&
      a.contentHash === anomaly.contentHash &&
      isAcceptanceReason(a.reason),
  )
}
