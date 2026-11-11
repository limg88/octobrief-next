import { z } from 'zod'

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')

const webSchema = z.object({ DATABASE_URL: postgresUrl })
const workerSchema = z.object({ DATABASE_WORKER_URL: postgresUrl })

export interface WebConfig {
  readonly databaseUrl: string
}

export interface WorkerConfig {
  readonly databaseUrl: string
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

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  return { databaseUrl: parse(webSchema, env).DATABASE_URL }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return { databaseUrl: parse(workerSchema, env).DATABASE_WORKER_URL }
}
