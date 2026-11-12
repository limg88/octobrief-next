import { ConnectorError } from '../errors.ts'

/**
 * Minutes added to the relative JQL bound: they cover a clock of Jira ahead of the worker's by
 * up to this much.
 */
export const CLOCK_SKEW_MARGIN_MINUTES = 15

/** The furthest relative bound sent to Jira: ten years, in minutes. */
export const MAX_RELATIVE_MINUTES = 10 * 366 * 24 * 60

/**
 * The JQL bound (`-Nm`, N minutes before Jira's own now) at or before the cursor. JQL dates are
 * read in the time zone of the account that queries; a relative date is not, so no zone is
 * needed: N is the time from the cursor to the start of the batch, rounded up to the minute,
 * plus `CLOCK_SKEW_MARGIN_MINUTES`. What was read at or before the cursor comes back and is
 * skipped locally.
 */
export function jqlSince(cursor: Date, asOf: Date): string {
  const minutes = Math.max(0, Math.ceil((asOf.getTime() - cursor.getTime()) / 60_000))
  const bound = minutes + CLOCK_SKEW_MARGIN_MINUTES
  // A cursor years old is not one a sync wrote: it is not read, the source starts again.
  if (!Number.isSafeInteger(bound) || bound > MAX_RELATIVE_MINUTES) {
    throw new ConnectorError('source_cursor_invalid')
  }
  return `-${bound}m`
}

/**
 * The query of a reconciliation: every issue of the chosen projects, by key, a stable order for
 * a listing read page by page while issues change.
 */
export function listJql(projectIds: readonly string[]): string {
  for (const id of projectIds) {
    if (!/^\d{1,18}$/.test(id)) throw new TypeError('a Jira project id is digits')
  }
  return `project in (${projectIds.join(', ')}) ORDER BY key ASC`
}

/**
 * The query of a sync: the issues of the chosen projects (by id, stable when a key is renamed;
 * ids are digits only, so nothing in them can change the query), changed since the cursor,
 * oldest change first and by key.
 */
export function syncJql(projectIds: readonly string[], since: string | null): string {
  for (const id of projectIds) {
    if (!/^\d{1,18}$/.test(id)) throw new TypeError('a Jira project id is digits')
  }
  if (since !== null && !/^-\d{1,9}m$/.test(since)) throw new TypeError('a relative JQL date')
  const where = [`project in (${projectIds.join(', ')})`]
  if (since !== null) where.push(`updated >= "${since}"`)
  return `${where.join(' AND ')} ORDER BY updated ASC, key ASC`
}
