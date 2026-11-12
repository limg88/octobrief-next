import type { ConnectorReader } from '@octobrief/connectors'
import { type SyncConfig, secretOf } from '../config.ts'
import { dwsiProvider } from '../providers/dwsi.ts'
import { type ClaudeRunner, claudeRunner, m365Source } from './m365.ts'
import type { SystemSource } from './source.ts'
import { jiraSite, trackerSource } from './tracker.ts'
import { warehouseSource } from './warehouse.ts'

export interface BuildOptions {
  readonly env: NodeJS.ProcessEnv
  readonly reader: ConnectorReader
  /** Development only: lets the warehouse be a database on this computer. */
  readonly allowLoopback?: boolean
  /** How Claude is run for Microsoft 365; by default the executable the configuration names. */
  readonly claude?: ClaudeRunner
}

/**
 * The sources a configuration names, with their secrets taken from the environment. A missing
 * secret is an error before anything is read.
 */
export function buildSources(config: SyncConfig, options: BuildOptions): SystemSource[] {
  const sources: SystemSource[] = []
  if (config.jira) {
    sources.push(
      trackerSource(
        {
          kind: 'jira',
          config: {
            site: jiraSite(config.jira.site),
            email: config.jira.email,
            readOnlyToken: true,
          },
          scope: config.jira.projects,
          secret: secretOf(options.env, config.jira.tokenEnv),
        },
        options.reader,
      ),
    )
  }
  if (config.ado) {
    sources.push(
      trackerSource(
        {
          kind: 'ado',
          config: {
            organization: config.ado.organization,
            host: 'dev.azure.com',
            readOnlyToken: true,
          },
          scope: [config.ado.project, ...config.ado.areas],
          secret: secretOf(options.env, config.ado.patEnv),
        },
        options.reader,
      ),
    )
  }
  if (config.dwsi) {
    sources.push(
      warehouseSource(
        dwsiProvider({
          host: config.dwsi.host,
          port: config.dwsi.port,
          database: config.dwsi.database,
          user: config.dwsi.user,
          password: secretOf(options.env, config.dwsi.passwordEnv),
          projectCodes: config.dwsi.codes,
          ownerEmail: config.dwsi.owner,
          tls: config.dwsi.tls,
          ...(options.allowLoopback ? { allowLoopback: true } : {}),
        }),
      ),
    )
  }
  if (config.m365) {
    sources.push(m365Source(config.m365, options.claude ?? claudeRunner(config.m365)))
  }
  return sources
}
