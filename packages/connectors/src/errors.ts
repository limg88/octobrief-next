/**
 * Why a sync, a connection test or a perimeter listing failed. The health of a source stores the
 * code; the PM reads it as `errors.sync_<code>` (apps/web/messages/it.json). A code never carries
 * a URL, a header, a body or a credential.
 */
export const SYNC_ERROR_CODES = [
  /** The safe HTTP client refused the call before the network (and audited it). */
  'call_blocked',
  /** The source answered with a redirect, which is never followed. */
  'redirect_refused',
  /** The source did not answer in time. */
  'source_timeout',
  /** The source could not be reached. */
  'source_unreachable',
  /** The source kept asking to slow down beyond what a run waits. */
  'source_rate_limited',
  /** The source said it is unavailable, beyond what a run waits. */
  'source_unavailable',
  /** The answer of the source is larger than a connector reads. */
  'response_too_large',
  /** The source refused the credentials. */
  'source_auth_failed',
  /** The credentials do not give access to what the source was asked. */
  'source_forbidden',
  /**
   * The permission the call needs is not granted (Microsoft 365: the IT has not consented the
   * delegated permission, or the PM cannot read what was chosen).
   */
  'source_not_authorized',
  /** What the source was asked does not exist (any more). */
  'source_not_found',
  /** The source answered with an error. */
  'source_http_error',
  /** The answer of the source is not what the connector expects. */
  'source_bad_response',
  /** The source is not configured well enough to be read (configuration, perimeter). */
  'source_not_configured',
  /** The saved position of the sync cannot be read: the sync has to start again. */
  'source_cursor_invalid',
  /** The credentials of the source are missing or no longer readable. */
  'source_credentials_missing',
  /**
   * The PM's own sign-in the source reads with has expired or was revoked (a refresh token
   * refused): the PM connects their account again.
   */
  'credentials_expired',
  /** The credentials can write to the source: the link is refused. */
  'write_scope_refused',
  /** The credentials can read more than the connector needs (a tenant-wide role): refused. */
  'scope_too_broad',
  /** The definition of the source (its views and columns) is not the one the connector reads. */
  'definition_changed',
  /** The certificate of the source cannot be verified: the connection is refused. */
  'tls_not_verified',
  /** The source asked for the password in a form that exposes it (clear text, MD5): refused. */
  'auth_not_secure',
  /**
   * The source names more people than can be hidden from the model: its sync stops (what it
   * already brought stays, its people still hidden).
   */
  'too_many_people',
  /** The source names a person in a form that cannot be kept (a name of over 1000 characters). */
  'person_not_storable',
  /** There is no connector for this kind of source in this installation. */
  'connector_unavailable',
  /** The Microsoft 365 connectors are switched off until the IT approves them. */
  'graph_connectors_disabled',
  /**
   * The folder of a «Cartella del Mac» source is not under a root the Admin allows now, or
   * leads outside it (a link), or is a place never read (hidden, the pilot's own, the system).
   */
  'folder_not_allowed',
  /**
   * The root of a «Cartella del Mac» source is no longer granted to the PM who connected it, or
   * that PM is no longer a PM of the project: the source reads nothing until it is again.
   */
  'folder_not_granted',
  /** The folder of a «Cartella del Mac» source is not there (moved, renamed, not synced). */
  'folder_not_found',
  /** Anything else. */
  'unexpected',
] as const
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number]

/** Failures that may pass by themselves: the queue tries the sync again. */
export const TRANSIENT_SYNC_ERRORS: ReadonlySet<SyncErrorCode> = new Set([
  'source_timeout',
  'source_unreachable',
  'source_rate_limited',
  'source_unavailable',
])

/**
 * Which check failed, for the log and the health of the source: a check name and, after a
 * colon, where (`key_missing:v_backlog_all`, `value_kind:v_invoice_all.lineid`,
 * `sqlstate_22012:v_project_revenue_all`). Built from constants only (names of checks, views,
 * columns, SQLSTATEs), never from a value; anything else is dropped.
 */
const FAILURE_REASON = /^[a-z][a-z0-9_]{0,39}(?::[a-z0-9_.]{1,80})?$/

/** The reason when it has the shape of one; null otherwise. */
export function failureReason(value: unknown): string | null {
  return typeof value === 'string' && FAILURE_REASON.test(value) ? value : null
}

/**
 * A connector failure: a code and nothing else, so that no URL, header or secret travels; with,
 * when the connector knows it, which of its checks failed (`reason`, see `failureReason`).
 */
export class ConnectorError extends Error {
  readonly code: SyncErrorCode
  readonly detail: { retryAfterMs?: number; reason?: string }

  constructor(code: SyncErrorCode, detail: { retryAfterMs?: number; reason?: string } = {}) {
    super(`connector failure: ${code}`)
    this.name = 'ConnectorError'
    this.code = code
    this.detail = detail
  }

  /** Which check failed, when known and well formed; never a value. */
  get reason(): string | null {
    return failureReason(this.detail.reason)
  }
}
