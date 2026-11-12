import { SYNC_SUBFOLDERS } from '@octobrief/connectors'
import { romeDateString, type SourceKind } from '@octobrief/domain'
import { configuredSystems, type SyncConfig } from './config.ts'
import { parseSince } from './since.ts'
import type { SyncState } from './sink/state.ts'

/** How long before its expiry the add-on starts warning about the access token. */
export const PAT_WARNING_MS = 24 * 60 * 60 * 1000

const LABELS: Readonly<Record<SourceKind, string>> = {
  jira: 'Jira',
  ado: 'Azure DevOps',
  dwsi: 'NetSuite (DWSI)',
  m365: 'Microsoft 365',
  files: 'Altri file',
}

/** What to tell the PM about the Azure DevOps token, or null when there is nothing to say. */
export function patWarning(config: SyncConfig, now: Date): string | null {
  const expires = config.ado?.patExpiresOn ? parseSince(config.ado.patExpiresOn) : null
  if (!expires) return null
  const left = expires.getTime() - now.getTime()
  if (left <= 0) {
    return `Il PAT di Azure DevOps è scaduto il ${config.ado?.patExpiresOn}: generane uno nuovo e aggiorna ${config.ado?.patEnv} nel file .env.`
  }
  if (left <= PAT_WARNING_MS) {
    return `Il PAT di Azure DevOps scade il ${config.ado?.patExpiresOn}: generane uno nuovo e aggiorna ${config.ado?.patEnv} nel file .env.`
  }
  return null
}

const moment = (iso: string | null): string =>
  iso ? `${romeDateString(new Date(iso))} ${new Date(iso).toISOString().slice(11, 16)} UTC` : '—'

/** The report a person reads in the folder: what was read, up to when, what went wrong. */
export function renderStatus(config: SyncConfig, state: SyncState, now: Date): string {
  const lines = [
    '# Stato della sincronizzazione',
    '',
    `Aggiornato: ${moment(now.toISOString())}. Intervallo: ogni ${config.everyMinutes} minuti.`,
    '',
    '| Sistema | Cartella | Elementi | Dal | Dati aggiornati al | Ultima passata | Esito |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const system of configuredSystems(config)) {
    const known = state[system]
    lines.push(
      `| ${[
        LABELS[system],
        `${SYNC_SUBFOLDERS[system]}/`,
        Object.keys(known?.items ?? {}).length,
        known?.since ? romeDateString(new Date(known.since)) : 'inizio',
        moment(known?.dataAsOf ?? null),
        moment(known?.lastRunAt ?? null),
        known?.lastError
          ? `non riuscita (${known.lastError})`
          : known?.lastRunAt
            ? 'ok'
            : 'mai eseguita',
      ].join(' | ')} |`,
    )
  }
  const warning = patWarning(config, now)
  if (warning) lines.push('', `**Attenzione**: ${warning}`)
  return `${lines.join('\n')}\n`
}
