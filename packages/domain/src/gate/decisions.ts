import { canonicalText } from '../canonical.ts'
import { type Acceptance, isAcceptanceReason, isAccepted } from './acceptance.ts'
import { type AnomalyStatus, resolutionOf } from './red-team-model.ts'

// The decisions of the PM on what the code shows and never resolves: a contradiction between
// sources, a value that changed since it was declared to the client. The PM chooses, with a
// reason of the same weight as for «Accetta così», and the decision holds only for the content
// it was taken on: a new side, or a new value, opens the anomaly again.

export type DecisionKind = 'contradiction' | 'declared_value'

export interface PmDecision {
  kind: DecisionKind
  code: string
  refKey: string
  contentHash: string
  /** What the PM chose: the side that holds, or «keep the new value». */
  choice: string
  reason: string
  by: string
  at: string
}

export interface DecidableAnomaly {
  code: string
  refKey: string
  contentHash: string
}

export type DecisionRefusal = 'not_decidable' | 'reason_too_short' | 'choice_missing'

export type DecisionResult =
  | { ok: true; decision: PmDecision }
  | { ok: false; refusal: DecisionRefusal }

const KIND_OF_CODE: Readonly<Record<string, DecisionKind>> = Object.freeze({
  contradiction_open: 'contradiction',
  declared_value_changed: 'declared_value',
})

/** Records the decision of the PM on one anomaly that is decided, not accepted. */
export function decideAnomaly(
  anomaly: DecidableAnomaly,
  input: { choice: string; reason: string; by: string; at: string },
): DecisionResult {
  const kind = Object.hasOwn(KIND_OF_CODE, anomaly.code) ? KIND_OF_CODE[anomaly.code] : undefined
  if (kind === undefined || resolutionOf(anomaly.code) !== 'decision') {
    return { ok: false, refusal: 'not_decidable' }
  }
  const choice = canonicalText(input.choice)
  if (choice === '') return { ok: false, refusal: 'choice_missing' }
  const reason = canonicalText(input.reason)
  if (!isAcceptanceReason(reason)) return { ok: false, refusal: 'reason_too_short' }
  return {
    ok: true,
    decision: {
      kind,
      code: anomaly.code,
      refKey: anomaly.refKey,
      contentHash: anomaly.contentHash,
      choice,
      reason,
      by: input.by,
      at: input.at,
    },
  }
}

/**
 * The status of an anomaly from what the PM did: accepted or decided on this very content, or
 * still open. How it may be closed depends on its code only.
 */
export function statusOf(
  anomaly: DecidableAnomaly,
  acceptances: readonly Acceptance[],
  decisions: readonly PmDecision[],
): AnomalyStatus {
  const resolution = resolutionOf(anomaly.code)
  if (resolution === 'acceptance' && isAccepted(anomaly, acceptances)) return 'accepted'
  if (resolution === 'decision' && isDecided(anomaly, decisions)) return 'decided'
  return 'open'
}

/** Whether the PM decided this anomaly, on this very content, with a reason. */
export function isDecided(anomaly: DecidableAnomaly, decisions: readonly PmDecision[]): boolean {
  if (resolutionOf(anomaly.code) !== 'decision') return false
  return decisions.some(
    (d) =>
      d.code === anomaly.code &&
      d.refKey === anomaly.refKey &&
      d.contentHash === anomaly.contentHash &&
      canonicalText(d.choice) !== '' &&
      isAcceptanceReason(d.reason),
  )
}
