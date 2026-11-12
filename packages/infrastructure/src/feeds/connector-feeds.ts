import { FeedError, type Logger, type SourceFeeds } from '@octobrief/application'
import { ConnectorError, createConnectorReader } from '@octobrief/connectors'

export interface ConnectorFeedsOptions {
  readonly logger: Logger
  /**
   * Development only: the loopback address of a fake Jira or Azure DevOps to read instead of
   * the public hosts. Never set in production (the configuration accepts loopback only).
   */
  readonly devEndpoints?: { readonly jira?: string | undefined; readonly ado?: string | undefined }
}

/** A failure of a connector as the application knows it: its code, nothing of the system. */
function asFeedError(error: unknown): never {
  if (error instanceof ConnectorError) throw new FeedError(error.code)
  throw error
}

/**
 * Jira and Azure DevOps through the read-only connectors (see `createConnectorReader`): calls
 * the safe HTTP client refuses are logged, failures become `FeedError`s with a code only.
 */
export function createConnectorFeeds(options: ConnectorFeedsOptions): SourceFeeds {
  const reader = createConnectorReader({
    ...(options.devEndpoints ? { devEndpoints: options.devEndpoints } : {}),
    onBlocked: async (call) => {
      options.logger.error('source call blocked', {
        reason: call.reason,
        method: call.method,
        host: call.host,
      })
    },
  })
  return {
    connect: (kind, rawConfig, secret, scope) =>
      reader.connect(kind, rawConfig, secret, scope).catch(asFeedError),
    pull: (source, cursor, signal) => reader.pull(source, cursor, signal).catch(asFeedError),
  }
}
