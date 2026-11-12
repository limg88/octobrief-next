import type { SourceKind } from '@octobrief/domain'
import { ConfigError, type SyncConfig, secretOf } from './config.ts'
import { createIngestClient, type Outcome, runFeeder } from './feeder.ts'
import { folderProvider } from './providers/folder.ts'

export interface PushOptions {
  readonly env: NodeJS.ProcessEnv
  readonly log?: (line: string) => void
  readonly fetch?: typeof fetch
}

/**
 * Sends the folder to Octobrief on its server: the subfolder of each system to the source
 * connected for it, with the token of that source. A system that fails does not stop the others.
 */
export async function runPush(
  config: SyncConfig,
  options: PushOptions,
): Promise<Array<{ system: SourceKind; outcome: Outcome | null; error: string | null }>> {
  if (!config.push) throw new ConfigError('manca il blocco "push" nella configurazione')
  const log = options.log ?? (() => {})
  const results: Array<{ system: SourceKind; outcome: Outcome | null; error: string | null }> = []
  for (const [system, target] of Object.entries(config.push.sources) as Array<
    [SourceKind, { id: string; tokenEnv: string }]
  >) {
    try {
      const deliver = createIngestClient({
        server: config.push.server,
        sourceId: target.id,
        token: secretOf(options.env, target.tokenEnv),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
      const outcome = await runFeeder(folderProvider(config.folder, system), deliver)
      results.push({ system, outcome, error: null })
      log(
        `${system}: ${outcome.created} nuovi, ${outcome.updated} aggiornati, ${outcome.unchanged} invariati, ${outcome.records} record, ${outcome.rows} righe`,
      )
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : String(failure)
      results.push({ system, outcome: null, error })
      log(`${system}: non inviata (${error})`)
    }
  }
  return results
}
