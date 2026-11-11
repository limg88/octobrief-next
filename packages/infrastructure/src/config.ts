import { DEFAULT_RETENTION_DAYS } from '@octobrief/domain'
import { z } from 'zod'

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
// Web and worker run from different directories: a relative path would point to two places.
const absolutePath = z.string().regex(/^\//, 'must be an absolute path')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const webSchema = z
  .object({
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
const workerSchema = z.object({
  DATABASE_WORKER_URL: postgresUrl,
  BLOB_DIR: absolutePath,
  RETENTION_DAYS: z.coerce.number().int().positive().default(DEFAULT_RETENTION_DAYS),
})

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
}

export interface WorkerConfig {
  readonly databaseUrl: string
  readonly blobDir: string
  readonly retentionDays: number
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
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ''),
  )
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
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = parse(workerSchema, env)
  return {
    databaseUrl: parsed.DATABASE_WORKER_URL,
    blobDir: parsed.BLOB_DIR,
    retentionDays: parsed.RETENTION_DAYS,
  }
}
