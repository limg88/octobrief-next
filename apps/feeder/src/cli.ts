// Octobrief feeder: reads something on this computer and delivers it to a source of a project.
//   node apps/feeder/src/cli.ts <provider> --server <url> --source <id> [options]
// The token of the source comes from OCTOBRIEF_FEEDER_TOKEN or --token-file, never from argv.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DATABASE_TLS_MODES, type DatabaseTls } from '@octobrief/connectors'
import { createIngestClient, FeederError, type Provider, runFeeder } from './feeder.ts'
import { commandProvider, m365Provider } from './providers/command.ts'
import { dwsiProvider } from './providers/dwsi.ts'
import { fileProvider } from './providers/file.ts'
import { folderProvider } from './providers/folder.ts'

const USAGE = `Uso: feeder <folder|file|m365|dwsi|command> --server <url> --source <id> [opzioni]
  folder   --path <cartella>
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

function providerOf(kind: string | undefined): Provider {
  switch (kind) {
    case 'folder':
      return folderProvider(need('path'))
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
