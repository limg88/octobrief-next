import { FeedError, type FeedSource, type Logger, type SourceFeeds } from '@octobrief/application'
import {
  type AnyConnector,
  type ConnectorContext,
  ConnectorError,
  createAdoConnector,
  createJiraConnector,
  createNetGuard,
  createSafeHttp,
  type Json,
  type PerimeterOption,
  SecretValue,
  type SyncBatch,
  toDelivery,
} from '@octobrief/connectors'
import { MAX_ITEMS_PER_DELIVERY, type PullSourceKind } from '@octobrief/domain'

const PROJECT_OPTION_PREFIX = 'project:'
/** Stored when the scope the PM gave matches nothing the credential can see. */
const NOTHING_TO_READ = 'source_not_configured'

export interface ConnectorFeedsOptions {
  readonly logger: Logger
  /**
   * Development only: the loopback address of a fake Jira or Azure DevOps to read instead of
   * the public hosts. Never set in production (the configuration accepts loopback only).
   */
  readonly devEndpoints?: { readonly jira?: string | undefined; readonly ado?: string | undefined }
}

function connectorsOf(options: ConnectorFeedsOptions): Record<PullSourceKind, AnyConnector> {
  const { jira, ado } = options.devEndpoints ?? {}
  const local = (origin: string) => ({ origin, host: new URL(origin).host, prefix: [] })
  return {
    jira: createJiraConnector(
      jira ? { endpoint: () => ({ ...local(jira), browse: jira }) } : undefined,
    ),
    ado: createAdoConnector(ado ? { endpoint: () => ({ ...local(ado), web: ado }) } : undefined),
  }
}

/** Whether an entry of the system is one the PM named: by its label, or its key in brackets. */
function inScope(option: PerimeterOption, scope: readonly string[]): boolean {
  const label = option.label.toLowerCase()
  return scope.some((raw) => {
    const wanted = raw.trim().toLowerCase()
    return wanted !== '' && (label === wanted || label.endsWith(`(${wanted})`))
  })
}

/**
 * Jira and Azure DevOps through the read-only connectors: every call goes through the safe HTTP
 * client (allowlisted paths, no redirects, no private addresses); failures are codes only.
 */
export function createConnectorFeeds(options: ConnectorFeedsOptions): SourceFeeds {
  const connectors = connectorsOf(options)
  const allowLoopback = Boolean(options.devEndpoints?.jira || options.devEndpoints?.ado)
  const onBlocked = async (call: { reason: string; method: string; host: string }) => {
    options.logger.error('source call blocked', {
      reason: call.reason,
      method: call.method,
      host: call.host,
    })
  }

  /** Runs `work` with the context of one source; the HTTP client is closed afterwards. */
  async function withContext<T>(
    kind: PullSourceKind,
    source: { config: unknown; perimeter: readonly string[]; secret: string | null },
    signal: AbortSignal,
    work: (connector: AnyConnector, ctx: ConnectorContext<unknown>) => Promise<T>,
  ): Promise<T> {
    const connector = connectors[kind]
    const http = createSafeHttp({
      rules: connector.rules(source.config),
      onBlocked,
      allowLoopbackHttp: allowLoopback,
      signal,
    })
    try {
      return await work(connector, {
        config: source.config,
        perimeter: source.perimeter,
        secret: source.secret === null ? null : new SecretValue(source.secret),
        http,
        net: createNetGuard({ privateHosts: [], onBlocked, allowLoopback }),
        signal,
        now: () => new Date(),
      })
    } catch (error) {
      if (error instanceof ConnectorError) throw new FeedError(error.code)
      throw error
    } finally {
      http.close()
    }
  }

  const parse = (kind: PullSourceKind, raw: unknown) => {
    try {
      return connectors[kind].parseConfig(raw)
    } catch (error) {
      if (error instanceof ConnectorError) throw new FeedError(error.code)
      throw error
    }
  }

  return {
    async connect(kind, rawConfig, secret, scope) {
      const signal = new AbortController().signal
      const optionsFor = (config: unknown) =>
        withContext(kind, { config, perimeter: [], secret }, signal, async (connector, ctx) => {
          const check = await connector.test(ctx)
          if (!check.ok) throw new FeedError(check.code)
          return connector.perimeterOptions(ctx) as Promise<PerimeterOption[]>
        })
      let config = parse(kind, rawConfig)
      let entries = await optionsFor(config)
      if (kind === 'ado') {
        // Azure DevOps lists projects first; its areas and iterations are the perimeter.
        const project = entries.find((entry) => inScope(entry, scope.slice(0, 1)))
        if (!project) throw new FeedError(NOTHING_TO_READ)
        const projectId = project.id.slice(PROJECT_OPTION_PREFIX.length)
        config = parse(kind, { ...(rawConfig as object), projectId })
        entries = await optionsFor(config)
      } else if (scope.length > 0) {
        entries = entries.filter((entry) => inScope(entry, scope))
      }
      if (entries.length === 0) throw new FeedError(NOTHING_TO_READ)
      return {
        config: config as Record<string, unknown>,
        perimeter: entries.map((entry) => entry.id),
      }
    },

    pull(source: FeedSource, cursor, signal) {
      const config = parse(source.kind, source.config)
      return withContext(source.kind, { ...source, config }, signal, async (connector, ctx) => {
        let from: unknown
        try {
          from = cursor === null || cursor === undefined ? null : connector.parseCursor(cursor)
        } catch {
          throw new FeedError('source_cursor_invalid')
        }
        const batch = await connector.sync(ctx, from, { maxItems: MAX_ITEMS_PER_DELIVERY, signal })
        return toDelivery(batch as SyncBatch<Json>, new Set(source.perimeter))
      })
    },
  }
}
