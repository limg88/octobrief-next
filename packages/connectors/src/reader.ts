import { MAX_ITEMS_PER_DELIVERY, type PullSourceKind } from '@octobrief/domain'
import { createAdoConnector } from './ado/connector.ts'
import { type ConnectorDelivery, toDelivery } from './delivery.ts'
import { ConnectorError } from './errors.ts'
import { createJiraConnector } from './jira/connector.ts'
import { createNetGuard } from './net-guard.ts'
import type { AnyConnector, ConnectorContext, Json, PerimeterOption, SyncBatch } from './port.ts'
import { createSafeHttp } from './safe-http.ts'
import { SecretValue } from './secret-value.ts'

const PROJECT_OPTION_PREFIX = 'project:'
/** The code when the scope the PM gave matches nothing the credential can see. */
const NOTHING_TO_READ = 'source_not_configured'

export interface ConnectorReaderOptions {
  /**
   * Development only: the loopback address of a fake Jira or Azure DevOps to read instead of
   * the public hosts. Never set in production.
   */
  readonly devEndpoints?: { readonly jira?: string | undefined; readonly ado?: string | undefined }
  /** Told of every call the safe HTTP client refused before the network. */
  readonly onBlocked?: (call: { reason: string; method: string; host: string }) => Promise<void>
}

/** A tracker to read: its settings, what to read of it, its credential. */
export interface ReadableSource {
  readonly kind: PullSourceKind
  readonly config: unknown
  readonly perimeter: readonly string[]
  readonly secret: string | null
}

export interface ConnectorReader {
  /**
   * Checks the settings and the credential against the system and returns the settings to keep
   * with the perimeter to read: the entries of the system that match `scope` (project keys or
   * names), or all of them when it is empty.
   */
  connect(
    kind: PullSourceKind,
    rawConfig: unknown,
    secret: string,
    scope: readonly string[],
  ): Promise<{ config: Record<string, unknown>; perimeter: string[] }>
  /** The next batch after `cursor` (null: from the beginning). */
  pull(source: ReadableSource, cursor: unknown, signal: AbortSignal): Promise<ConnectorDelivery>
}

function connectorsOf(options: ConnectorReaderOptions): Record<PullSourceKind, AnyConnector> {
  const { jira, ado } = options.devEndpoints ?? {}
  const local = (origin: string) => ({ origin, host: new URL(origin).host, prefix: [] })
  return {
    jira: createJiraConnector(
      jira ? { endpoint: () => ({ ...local(jira), browse: jira }) } : undefined,
    ),
    // As on dev.azure.com, the organization is the first segment of every path.
    ado: createAdoConnector(
      ado
        ? {
            endpoint: (config) => ({ ...local(ado), prefix: [config.organization], web: ado }),
          }
        : undefined,
    ),
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
 * client (allowlisted paths, no redirects, no private addresses). Failures are `ConnectorError`s
 * with a code only. Used by the worker and by the sync add-on alike.
 */
export function createConnectorReader(options: ConnectorReaderOptions = {}): ConnectorReader {
  const connectors = connectorsOf(options)
  const allowLoopback = Boolean(options.devEndpoints?.jira || options.devEndpoints?.ado)
  const onBlocked = options.onBlocked ?? (async () => {})

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
    } finally {
      http.close()
    }
  }

  return {
    async connect(kind, rawConfig, secret, scope) {
      const signal = new AbortController().signal
      const optionsFor = (config: unknown) =>
        withContext(kind, { config, perimeter: [], secret }, signal, async (connector, ctx) => {
          const check = await connector.test(ctx)
          if (!check.ok) throw new ConnectorError(check.code)
          return connector.perimeterOptions(ctx) as Promise<PerimeterOption[]>
        })
      let config = connectors[kind].parseConfig(rawConfig)
      let entries = await optionsFor(config)
      if (kind === 'ado') {
        // Azure DevOps lists projects first; its areas and iterations are the perimeter.
        const project = entries.find((entry) => inScope(entry, scope.slice(0, 1)))
        if (!project) throw new ConnectorError(NOTHING_TO_READ)
        const projectId = project.id.slice(PROJECT_OPTION_PREFIX.length)
        config = connectors[kind].parseConfig({ ...(rawConfig as object), projectId })
        entries = await optionsFor(config)
      } else if (scope.length > 0) {
        entries = entries.filter((entry) => inScope(entry, scope))
      }
      if (entries.length === 0) throw new ConnectorError(NOTHING_TO_READ)
      return {
        config: config as Record<string, unknown>,
        perimeter: entries.map((entry) => entry.id),
      }
    },

    async pull(source, cursor, signal) {
      const config = connectors[source.kind].parseConfig(source.config)
      return withContext(source.kind, { ...source, config }, signal, async (connector, ctx) => {
        let from: unknown
        try {
          from = cursor === null || cursor === undefined ? null : connector.parseCursor(cursor)
        } catch {
          throw new ConnectorError('source_cursor_invalid')
        }
        const batch = await connector.sync(ctx, from, { maxItems: MAX_ITEMS_PER_DELIVERY, signal })
        return toDelivery(batch as SyncBatch<Json>, new Set(source.perimeter))
      })
    },
  }
}
