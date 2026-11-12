// What bounds one conversation with a backend that holds it as a session (a seat does): how
// many generations, for how long. A question or a slot reads only as long as its session allows.

/** What bounds one session of a runner: the limits of its backend and the time of one call. */
export interface SessionLimits {
  generationsPerSession: number | null
  sessionSeconds: number | null
  /** The longest one call may take, in milliseconds. */
  callTimeoutMs: number
}

/**
 * The reading turns a question may take so that its whole session fits the backend: the reading,
 * the answer and one retry of a malformed answer are at most the generations of a session, and
 * all of them at their longest last no more than a session. At least one reading turn, at most
 * `maxReading` (the turns without limits).
 */
export function askReadingTurns(session: SessionLimits | undefined, maxReading: number): number {
  const calls = sessionCalls(session)
  if (calls === null) return maxReading
  // The answer and its one retry come after the reading.
  const afterReading = 2
  return Math.max(1, Math.min(maxReading, calls - afterReading))
}

/**
 * The model calls one session may make: at most its generations, and as many calls at their
 * longest as its length holds; null without limits.
 */
export function sessionCalls(session: SessionLimits | undefined): number | null {
  if (!session) return null
  let calls = Number.POSITIVE_INFINITY
  if (session.generationsPerSession !== null) calls = session.generationsPerSession
  if (session.sessionSeconds !== null && session.callTimeoutMs > 0) {
    calls = Math.min(calls, Math.floor((session.sessionSeconds * 1000) / session.callTimeoutMs))
  }
  // Never fewer than a session needs (a reading turn, the answer and its retry): a length shorter
  // than three calls at their longest still lets a question or a slot read and answer once.
  return Number.isFinite(calls) ? Math.max(MIN_SESSION_CALLS, calls) : null
}

/** The fewest calls a session holds: one reading turn, the answer and its one retry. */
export const MIN_SESSION_CALLS = 3
