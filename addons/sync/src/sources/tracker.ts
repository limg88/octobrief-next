import type { ConnectorReader } from '@octobrief/connectors'
import type { PullSourceKind } from '@octobrief/domain'
import type { SystemSource } from './source.ts'

/** Batches one run reads at most; the next run goes on from the saved cursor. */
export const MAX_TRACKER_BATCHES = 500

export interface TrackerOptions {
  readonly kind: PullSourceKind
  /** The settings as the connector reads them (site and account, or organization). */
  readonly config: Readonly<Record<string, unknown>>
  /** Project keys or names to read; for Azure DevOps, the one project and then its areas. */
  readonly scope: readonly string[]
  readonly secret: string
}

/** `contoso` from `contoso`, `contoso.atlassian.net` or `https://contoso.atlassian.net/`. */
export function jiraSite(site: string): string {
  return site
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\.atlassian\.net$/i, '')
}

/**
 * The cursor a connector would have saved after reading everything before a day: the next
 * reading gives what changed from that day on. The id is one no item has, so nothing changed at
 * that very instant is taken for already read.
 */
export function cursorFrom(kind: PullSourceKind, since: Date | null): unknown {
  if (since === null) return null
  const at = since.toISOString()
  return kind === 'jira' ? { updated: at, ids: ['0'] } : { changedAt: at, id: 1 }
}

/**
 * Jira or Azure DevOps through the read-only connector: the credential is checked and the
 * perimeter resolved at each run, then the items changed after the cursor are read batch by
 * batch.
 */
export function trackerSource(options: TrackerOptions, reader: ConnectorReader): SystemSource {
  return {
    system: options.kind,
    scope: options.scope
      .map((entry) => entry.trim().toLowerCase())
      .sort()
      .join('|'),
    startCursor: (since) => cursorFrom(options.kind, since),
    async *batches(cursor, signal) {
      const { config, perimeter } = await reader.connect(
        options.kind,
        options.config,
        options.secret,
        options.scope,
      )
      const source = { kind: options.kind, config, perimeter, secret: options.secret }
      let from = cursor
      for (let batch = 0; batch < MAX_TRACKER_BATCHES; batch++) {
        const read = await reader.pull(source, from, signal)
        from = read.nextCursor
        yield { delivery: read, cursor: from }
        if (read.done) return
      }
    },
  }
}
