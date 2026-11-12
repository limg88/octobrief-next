import { DEFAULT_RETENTION_DAYS } from '@octobrief/domain'
import { z } from 'zod'
import { readSecretsKey, type SecretsKey } from './secrets/vault.ts'

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
// Web and worker run from different directories: a relative path would point to two places.
const absolutePath = z.string().regex(/^\//, 'must be an absolute path')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const loopbackUrl = z
  .url()
  .refine((url) => LOCAL_HOSTS.has(new URL(url).hostname), 'must be a loopback address')

// The key that seals the credentials of the sources, and (development only) the loopback
// addresses of fake source systems.
const sourcesShape = {
  SECRETS_KEY: z.string().refine((value) => readSecretsKey(value) !== null, 'not a secrets key'),
  SOURCES_DEV_JIRA_URL: loopbackUrl.optional(),
  SOURCES_DEV_ADO_URL: loopbackUrl.optional(),
}

const webSchema = z
  .object({
    ...sourcesShape,
    DATABASE_URL: postgresUrl,
    PUBLIC_URL: z.url(),
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_ALLOW_INSECURE_ISSUER: z.enum(['true', 'false']).default('false'),
    ADMIN_EMAILS: z.string().default(''),
    BLOB_DIR: absolutePath,
  })
  // Plain HTTP only towards a loopback issuer (the fake one in development).
  .refine(
    (env) =>
      env.OIDC_ALLOW_INSECURE_ISSUER === 'false' ||
      LOCAL_HOSTS.has(new URL(env.OIDC_ISSUER).hostname),
    { path: ['OIDC_ALLOW_INSECURE_ISSUER'], message: 'only for a loopback issuer' },
  )
/** How often the worker reads Jira and Azure DevOps. */
const DEFAULT_SYNC_MINUTES = 15
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEFAULT_EMBEDDING_MODEL = 'bge-m3'
const DEFAULT_EMBEDDING_DIGEST = 'unpinned'

// The fake model is the default: nothing leaves the machine until a gateway is configured.
const modelShape = {
  LLM_BACKEND: z.enum(['fake', 'llm-api']).default('fake'),
  LLM_API_URL: z.url().optional(),
  LLM_API_TOKEN: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  LLM_ALLOWED_BACKENDS: z.string().optional(),
  LLM_FAKE_TRANSCRIPT: absolutePath.optional(),
  EMBEDDING_BACKEND: z.enum(['fake', 'ollama', 'llm-api', 'none']).default('fake'),
  EMBEDDING_MODEL: z.string().min(1).default(DEFAULT_EMBEDDING_MODEL),
  EMBEDDING_DIGEST: z.string().min(1).default(DEFAULT_EMBEDDING_DIGEST),
  OLLAMA_URL: z.url().default(DEFAULT_OLLAMA_URL),
}
type ModelEnv = z.infer<z.ZodObject<typeof modelShape>>
const LLM_API_KEYS = ['LLM_API_URL', 'LLM_API_TOKEN', 'LLM_MODEL'] as const

/** The gateway needs its address, token and model; its encoder needs the gateway. */
function checkModel(env: ModelEnv, ctx: z.RefinementCtx): void {
  const missing = (key: string) =>
    ctx.addIssue({ code: 'custom', path: [key], message: 'required with llm-api' })
  if (env.LLM_BACKEND === 'llm-api') {
    for (const key of LLM_API_KEYS) if (!env[key]) missing(key)
  } else if (env.EMBEDDING_BACKEND === 'llm-api') {
    missing('LLM_BACKEND')
  }
}

const workerSchema = z
  .object({
    DATABASE_WORKER_URL: postgresUrl,
    BLOB_DIR: absolutePath,
    RETENTION_DAYS: z.coerce.number().int().positive().default(DEFAULT_RETENTION_DAYS),
    SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(DEFAULT_SYNC_MINUTES),
    ...sourcesShape,
    ...modelShape,
  })
  .superRefine(checkModel)

/** What both processes need to work with sources. */
export interface SourcesConfig {
  readonly secretsKey: SecretsKey
  readonly devEndpoints: { readonly jira?: string; readonly ado?: string }
}

export interface WebConfig {
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly secureCookies: boolean
  readonly oidc: {
    readonly issuer: string
    readonly clientId: string
    readonly clientSecret: string
    readonly allowInsecureIssuer: boolean
  }
  readonly adminEmails: ReadonlySet<string>
  readonly blobDir: string
  readonly sources: SourcesConfig
}

/** Which model reads the documents and which encoder makes the vectors of their text. */
export interface ModelConfig {
  readonly chat:
    | { readonly backend: 'fake' }
    | {
        readonly backend: 'llm-api'
        readonly url: string
        readonly token: string
        readonly model: string
        readonly timeoutMs?: number
      }
  readonly embedding:
    | { readonly backend: 'fake' | 'none' }
    | { readonly backend: 'ollama'; readonly url: string; readonly model: string }
    | { readonly backend: 'llm-api'; readonly model: string; readonly digest: string }
  /** Backends allowed to receive project data; absent: the configured ones. */
  readonly allowedBackends?: readonly string[]
  readonly fakeTranscriptPath?: string
}

export interface WorkerConfig {
  readonly databaseUrl: string
  readonly blobDir: string
  readonly retentionDays: number
  readonly syncIntervalMinutes: number
  readonly sources: SourcesConfig
  readonly model: ModelConfig
}

/** Thrown when the environment is incomplete; the message names the keys, never their values. */
export class ConfigError extends Error {
  constructor(keys: readonly string[]) {
    super(`invalid or missing environment keys: ${keys.join(', ')}`)
    this.name = 'ConfigError'
  }
}

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env)
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => issue.path.join('.')))
  }
  return result.data
}

function emailList(raw: string): Set<string> {
  return new Set(list(raw).map((email) => email.toLowerCase()))
}

function sourcesConfig(env: {
  SECRETS_KEY: string
  SOURCES_DEV_JIRA_URL?: string | undefined
  SOURCES_DEV_ADO_URL?: string | undefined
}): SourcesConfig {
  return {
    secretsKey: readSecretsKey(env.SECRETS_KEY) as SecretsKey,
    devEndpoints: {
      ...(env.SOURCES_DEV_JIRA_URL ? { jira: env.SOURCES_DEV_JIRA_URL } : {}),
      ...(env.SOURCES_DEV_ADO_URL ? { ado: env.SOURCES_DEV_ADO_URL } : {}),
    },
  }
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = parse(webSchema, env)
  const publicUrl = new URL(parsed.PUBLIC_URL).origin
  return {
    databaseUrl: parsed.DATABASE_URL,
    publicUrl,
    secureCookies: publicUrl.startsWith('https:'),
    oidc: {
      issuer: parsed.OIDC_ISSUER,
      clientId: parsed.OIDC_CLIENT_ID,
      clientSecret: parsed.OIDC_CLIENT_SECRET,
      allowInsecureIssuer: parsed.OIDC_ALLOW_INSECURE_ISSUER === 'true',
    },
    adminEmails: emailList(parsed.ADMIN_EMAILS),
    blobDir: parsed.BLOB_DIR,
    sources: sourcesConfig(parsed),
  }
}

function list(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function embeddingConfig(env: ModelEnv): ModelConfig['embedding'] {
  switch (env.EMBEDDING_BACKEND) {
    case 'ollama':
      return { backend: 'ollama', url: env.OLLAMA_URL, model: env.EMBEDDING_MODEL }
    case 'llm-api':
      return { backend: 'llm-api', model: env.EMBEDDING_MODEL, digest: env.EMBEDDING_DIGEST }
    default:
      return { backend: env.EMBEDDING_BACKEND }
  }
}

function modelConfig(env: ModelEnv): ModelConfig {
  const chat: ModelConfig['chat'] =
    env.LLM_BACKEND === 'llm-api'
      ? {
          backend: 'llm-api',
          url: env.LLM_API_URL as string,
          token: env.LLM_API_TOKEN as string,
          model: env.LLM_MODEL as string,
          ...(env.LLM_TIMEOUT_MS ? { timeoutMs: env.LLM_TIMEOUT_MS } : {}),
        }
      : { backend: 'fake' }
  return {
    chat,
    embedding: embeddingConfig(env),
    ...(env.LLM_ALLOWED_BACKENDS ? { allowedBackends: list(env.LLM_ALLOWED_BACKENDS) } : {}),
    ...(env.LLM_FAKE_TRANSCRIPT ? { fakeTranscriptPath: env.LLM_FAKE_TRANSCRIPT } : {}),
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = parse(workerSchema, env)
  return {
    databaseUrl: parsed.DATABASE_WORKER_URL,
    blobDir: parsed.BLOB_DIR,
    retentionDays: parsed.RETENTION_DAYS,
    syncIntervalMinutes: parsed.SYNC_INTERVAL_MINUTES,
    sources: sourcesConfig(parsed),
    model: modelConfig(parsed),
  }
}
