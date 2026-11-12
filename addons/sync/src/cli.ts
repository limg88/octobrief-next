// Octobrief sync add-on. Two ways to use it:
//   octobrief-sync init|check|pull|push --config <file>   keeps a folder up to date from the
//     systems of a project (Jira, Azure DevOps, Microsoft 365, NetSuite) and sends it to Octobrief;
//   octobrief-sync <provider> --server <url> --source <id> delivers one thing to one source.
// Secrets come from the environment (or the private file the configuration names), never argv.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createConnectorReader, DATABASE_TLS_MODES, type DatabaseTls } from '@octobrief/connectors'
import { SOURCE_KINDS, type SourceKind } from '@octobrief/domain'
import { checkAccess } from './check.ts'
import {
  ConfigError,
  configuredSystems,
  EXAMPLE_CONFIG,
  readConfig,
  type SyncConfig,
} from './config.ts'
import { createIngestClient, FeederError, type Provider, runFeeder } from './feeder.ts'
import { commandProvider, m365Provider } from './providers/command.ts'
import { dwsiProvider } from './providers/dwsi.ts'
import { fileProvider } from './providers/file.ts'
import { folderProvider } from './providers/folder.ts'
import { runPull } from './pull.ts'
import { runPush } from './push.ts'
import { every } from './schedule.ts'
import { parseSince } from './since.ts'
import { buildSources } from './sources/build.ts'
import { patWarning } from './status.ts'

const USAGE = `Uso: octobrief-sync <comando> [opzioni]

Cartella sincronizzata (configurazione in un file JSON fuori dal repository):
  init <file>                    scrive una configurazione di esempio
  check --config <file>          controlla configurazione, segreti e accesso a Jira e Azure DevOps
  pull  --config <file> [--once] [--every <minuti>] [--since <aaaa-mm-gg|gg/mm/aaaa>]
                                 legge le fonti e aggiorna la cartella
  push  --config <file> [--once] [--every <minuti>]
                                 invia la cartella a Octobrief (blocco "push" della configurazione)
  Senza --once i comandi si ripetono: ogni --every minuti, o "everyMinutes" della configurazione.

Una consegna a una fonte: <folder|file|m365|dwsi|command> --server <url> --source <id> [opzioni]
  folder   --path <cartella> [--system jira|ado|m365|dwsi|files]   (con --system: cartella sincronizzata)
  file     --path <delivery.json>
  m365     --query <testo> [--days 7] [--claude <eseguibile>]
  dwsi     --host <h> [--port 5432] --database <db> --user <u> --codes PRJ000001,PRJ000002
           --owner <email del PM> [--tls verify_full|unverified|plaintext]   (password: DWSI_PASSWORD)
  command  --exec <programma> [--arg <a>]...   (stampa una delivery JSON)
Token: variabile OCTOBRIEF_FEEDER_TOKEN oppure --token-file <file>.`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    source: { type: 'string' },
    'token-file': { type: 'string' },
    path: { type: 'string' },
    system: { type: 'string' },
    query: { type: 'string' },
    days: { type: 'string', default: '7' },
    claude: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string', default: '5432' },
    database: { type: 'string' },
    user: { type: 'string' },
    codes: { type: 'string' },
    owner: { type: 'string' },
    tls: { type: 'string', default: 'verify_full' },
    exec: { type: 'string' },
    arg: { type: 'string', multiple: true },
    config: { type: 'string' },
    once: { type: 'boolean', default: false },
    every: { type: 'string' },
    since: { type: 'string' },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const need = (name: keyof typeof values): string => {
  const value = values[name]
  if (typeof value !== 'string' || value === '') fail(`Manca --${name}\n\n${USAGE}`)
  return value
}

function systemOf(value: string | undefined): SourceKind | undefined {
  if (value === undefined) return undefined
  if (!(SOURCE_KINDS as readonly string[]).includes(value)) fail(`--system non valido\n\n${USAGE}`)
  return value as SourceKind
}

function providerOf(kind: string | undefined): Provider {
  switch (kind) {
    case 'folder':
      return folderProvider(need('path'), systemOf(values.system))
    case 'file':
      return fileProvider(need('path'))
    case 'm365':
      return m365Provider({
        query: need('query'),
        days: Number(values.days),
        ...(values.claude ? { claude: values.claude } : {}),
      })
    case 'command':
      return commandProvider({ name: 'command', command: need('exec'), args: values.arg ?? [] })
    case 'dwsi': {
      const tls = need('tls')
      if (!(DATABASE_TLS_MODES as readonly string[]).includes(tls)) fail(`--tls non valido: ${tls}`)
      return dwsiProvider({
        host: need('host'),
        port: Number(values.port),
        database: need('database'),
        user: need('user'),
        password: process.env.DWSI_PASSWORD ?? fail('Manca la variabile DWSI_PASSWORD'),
        projectCodes: need('codes').split(','),
        ownerEmail: need('owner'),
        tls: tls as DatabaseTls,
      })
    }
    default:
      return fail(USAGE)
  }
}

/** Loads the private file of secrets a configuration names; what is already set wins. */
function loadSecrets(config: SyncConfig): void {
  if (!config.envFile) return
  try {
    process.loadEnvFile(config.envFile)
  } catch {
    fail(`Il file dei segreti non si legge: ${config.envFile}`)
  }
}

/** Runs once, or again and again until the process is stopped. */
async function repeat(config: SyncConfig, task: () => Promise<void>): Promise<void> {
  if (values.once) return task()
  const minutes = values.every ? Number(values.every) : config.everyMinutes
  if (!Number.isInteger(minutes) || minutes <= 0) fail('--every vuole un numero di minuti')
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())
  console.log(`Ogni ${minutes} minuti; Ctrl+C per fermare.`)
  await every(minutes, task, {
    signal: stop.signal,
    onError: (error) => console.error(`Passata non riuscita: ${(error as Error).message}`),
  })
}

const reader = () =>
  createConnectorReader({
    devEndpoints: {
      jira: process.env.SOURCES_DEV_JIRA_URL,
      ado: process.env.SOURCES_DEV_ADO_URL,
    },
  })

async function syncCommand(command: string): Promise<void> {
  if (command === 'init') {
    const target = positionals[1] ?? fail(`Manca il file da scrivere\n\n${USAGE}`)
    if (existsSync(target)) fail(`Il file esiste già: ${target}`)
    writeFileSync(target, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`, { mode: 0o600 })
    console.log(`Configurazione di esempio in ${target}: sostituisci i valori fra <…>.`)
    return
  }
  const config = readConfig(need('config'))
  loadSecrets(config)
  if (values.since && parseSince(values.since) === null) fail('--since vuole un giorno: 2026-01-01')
  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (command === 'push') {
    await repeat(config, async () => {
      await runPush(config, { env: process.env, log })
    })
    return
  }
  const sources = buildSources(config, { env: process.env, reader: reader() })
  if (command === 'check') {
    console.log(`Configurazione valida. Cartella: ${config.folder}`)
    console.log(`Fonti: ${configuredSystems(config).join(', ') || 'nessuna'}`)
    const warning = patWarning(config, new Date())
    if (warning) console.log(`ATTENZIONE: ${warning}`)
    for (const failure of await checkAccess(config, process.env, reader())) console.log(failure)
    return
  }
  await repeat(config, async () => {
    await runPull(config, sources, { since: values.since, log })
  })
}

const SYNC_COMMANDS = ['init', 'check', 'pull', 'push']
if (SYNC_COMMANDS.includes(positionals[0] ?? '')) {
  try {
    await syncCommand(positionals[0] as string)
  } catch (error) {
    if (error instanceof ConfigError) fail(`Errore: ${error.message}`)
    throw error
  }
  process.exit(0)
}

const provider = providerOf(positionals[0])
const tokenFile = values['token-file']
const token = (
  tokenFile ? readFileSync(tokenFile, 'utf8') : (process.env.OCTOBRIEF_FEEDER_TOKEN ?? '')
).trim()
if (token === '') fail('Manca il token: OCTOBRIEF_FEEDER_TOKEN oppure --token-file')

try {
  await runFeeder(
    provider,
    createIngestClient({ server: need('server'), sourceId: need('source'), token }),
    (line) => console.log(line),
  )
} catch (error) {
  if (error instanceof FeederError) fail(`Errore (${error.code}): ${error.message}`)
  throw error
}
