import { ConnectorError, type ConnectorReader } from '@octobrief/connectors'
import { type SyncConfig, secretOf } from './config.ts'
import { jiraSite } from './sources/tracker.ts'

/**
 * Tries the credentials of the trackers against their systems, without reading any item. One
 * line for each: what it can read, or the code of what went wrong.
 */
export async function checkAccess(
  config: SyncConfig,
  env: NodeJS.ProcessEnv,
  reader: ConnectorReader,
): Promise<string[]> {
  const lines: string[] = []
  const tried = async (label: string, connect: () => Promise<{ perimeter: string[] }>) => {
    try {
      const { perimeter } = await connect()
      lines.push(`${label}: accesso riuscito, ${perimeter.length} voci nel perimetro`)
    } catch (error) {
      const code = error instanceof ConnectorError ? error.code : (error as Error).message
      lines.push(`${label}: accesso NON riuscito (${code})`)
    }
  }
  const { jira, ado } = config
  if (jira) {
    await tried('Jira', () =>
      reader.connect(
        'jira',
        { site: jiraSite(jira.site), email: jira.email, readOnlyToken: true },
        secretOf(env, jira.tokenEnv),
        jira.projects,
      ),
    )
  }
  if (ado) {
    await tried('Azure DevOps', () =>
      reader.connect(
        'ado',
        { organization: ado.organization, host: 'dev.azure.com', readOnlyToken: true },
        secretOf(env, ado.patEnv),
        [ado.project],
      ),
    )
  }
  return lines
}
