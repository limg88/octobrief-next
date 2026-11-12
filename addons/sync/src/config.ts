import { readFileSync } from 'node:fs'
import { DATABASE_TLS_MODES } from '@octobrief/connectors'
import { SOURCE_KINDS, type SourceKind } from '@octobrief/domain'
import { z } from 'zod'
import { parseSince } from './since.ts'

/** How often the folder is brought up to date when the configuration does not say. */
export const DEFAULT_EVERY_MINUTES = 30
/** How far back Microsoft 365 is read when no start day is given. */
export const DEFAULT_M365_DAYS = 7

/** The Microsoft 365 connector of claude.ai as Claude Code names its tools. */
export const DEFAULT_M365_TOOLS = 'mcp__claude_ai_Microsoft_365'

const absolutePath = z.string().regex(/^\//, 'must be an absolute path')
/** The name of the environment variable that holds a secret: the file never holds the secret. */
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be the name of a variable')
const since = z
  .string()
  .refine((text) => parseSince(text) !== null, 'must be a day: 2026-01-01 or 01/01/2026')
  .optional()
const list = z.array(z.string().min(1)).default([])

const JiraSchema = z.object({
  /** `contoso` or `contoso.atlassian.net`. */
  site: z.string().min(1),
  email: z.email(),
  tokenEnv: envName,
  /** Project keys or names; empty: every project the token sees. */
  projects: list,
  since,
})

const AdoSchema = z.object({
  organization: z.string().min(1),
  project: z.string().min(1),
  patEnv: envName,
  /** The day the personal access token expires: the add-on warns the day before. */
  patExpiresOn: since,
  since,
})

const DwsiSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  passwordEnv: envName,
  codes: z.array(z.string().min(1)).min(1),
  /** The PM the perimeter is bound to. */
  owner: z.email(),
  tls: z.enum(DATABASE_TLS_MODES).default('verify_full'),
  since,
})

const M365Schema = z.object({
  since,
  days: z.number().int().positive().default(DEFAULT_M365_DAYS),
  /** Words, phrases or e-mail addresses to search for. */
  keywords: list,
  outlook: z.object({ folders: list, mailboxes: list }).default({ folders: [], mailboxes: [] }),
  teams: z.object({ channels: list, chats: list }).default({ channels: [], chats: [] }),
  sharepoint: z.object({ paths: list }).default({ paths: [] }),
  /** The Claude executable that has the Microsoft 365 connector. */
  claude: z.string().min(1).default('claude'),
  /**
   * The tools Claude may use without asking: the read tools of the Microsoft 365 connector, as
   * `claude mcp list` names it on the PM's computer.
   */
  allowedTools: z.array(z.string().min(1)).default([DEFAULT_M365_TOOLS]),
  /** The model Claude runs with (an alias such as `sonnet` or a full id); its own default if absent. */
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/)
    .optional(),
})

const PushSchema = z.object({
  server: z.url(),
  sources: z.partialRecord(z.enum(SOURCE_KINDS), z.object({ id: z.uuid(), tokenEnv: envName })),
})

export const SyncConfigSchema = z.object({
  /** Where the files are written: one folder for one project. */
  folder: absolutePath,
  everyMinutes: z.number().int().positive().default(DEFAULT_EVERY_MINUTES),
  /** The day every source is read from, unless it names its own. */
  since,
  /** A private file of `NAME=value` lines with the secrets, loaded before anything is read. */
  envFile: absolutePath.optional(),
  jira: JiraSchema.optional(),
  ado: AdoSchema.optional(),
  dwsi: DwsiSchema.optional(),
  m365: M365Schema.optional(),
  push: PushSchema.optional(),
})
export type SyncConfig = z.infer<typeof SyncConfigSchema>

/** Thrown for a configuration that cannot be used; the message names keys, never values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseConfig(raw: unknown): SyncConfig {
  const result = SyncConfigSchema.safeParse(raw)
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join('.') || '(file)')
    throw new ConfigError(`configurazione non valida: ${[...new Set(keys)].join(', ')}`)
  }
  return result.data
}

export function readConfig(path: string): SyncConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ConfigError(`il file di configurazione non si legge o non è JSON: ${path}`)
  }
  return parseConfig(raw)
}

/** The secret a variable holds; an error that names the variable when it is not set. */
export function secretOf(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`manca la variabile d'ambiente ${name}`)
  return value
}

/** The systems a configuration reads, in the order they are read. */
export function configuredSystems(config: SyncConfig): SourceKind[] {
  const systems: SourceKind[] = []
  if (config.jira) systems.push('jira')
  if (config.ado) systems.push('ado')
  if (config.dwsi) systems.push('dwsi')
  if (config.m365) systems.push('m365')
  return systems
}

/** The day a system is read from: its own, or the one of the whole configuration; null: no limit. */
export function sinceOf(config: SyncConfig, system: SourceKind, override?: string): Date | null {
  const own = system === 'files' ? undefined : config[system]?.since
  const text = override ?? own ?? config.since
  return text ? parseSince(text) : null
}

/** A configuration to start from: every value is a placeholder. */
export const EXAMPLE_CONFIG = {
  folder: '/Users/<tu>/OctobriefSync/<progetto>',
  everyMinutes: DEFAULT_EVERY_MINUTES,
  since: '2026-01-01',
  envFile: '/Users/<tu>/.octobrief/<progetto>.env',
  jira: {
    site: '<sito>.atlassian.net',
    email: '<tua email>',
    tokenEnv: 'JIRA_TOKEN',
    projects: ['<CHIAVE>'],
  },
  ado: {
    organization: '<organizzazione>',
    project: '<progetto>',
    patEnv: 'ADO_PAT',
    patExpiresOn: '2026-12-31',
  },
  dwsi: {
    host: '<host del database>',
    port: 5432,
    database: '<database>',
    user: '<utente in sola lettura>',
    passwordEnv: 'DWSI_PASSWORD',
    codes: ['PRJ000000'],
    owner: '<tua email>',
    tls: 'plaintext',
  },
  m365: {
    keywords: ['<parola o frase>', '<persona@cliente.example>'],
    outlook: { folders: ['<cartella>'], mailboxes: [] },
    teams: { channels: ['<Team>/<Canale>'], chats: [] },
    sharepoint: { paths: ['https://<tenant>.sharepoint.com/sites/<sito>/<cartella>'] },
    claude: 'claude',
  },
} as const
