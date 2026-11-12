// Helpers shared by test setup (db tests, e2e supervisor) and the local dev supervisor.
// Never imported by production sources.
import type { ChildProcess } from 'node:child_process'

/** The same connection URL pointing at another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

/**
 * Waits, a bounded time, until a database has no sessions left (`count` reads
 * `pg_stat_activity` for it): a pool resolves its end before its sockets are closed, and a
 * forced drop would then terminate a backend of a client already ending (SQLSTATE 57P01).
 */
export async function waitForNoSessions(
  count: () => Promise<number>,
  { attempts = 50, stepMs = 20 }: { attempts?: number; stepMs?: number } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await count()) === 0) return
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** The query counting the sessions of the database `$1`. */
export const SESSIONS_OF_DATABASE =
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1'

/** Sends SIGTERM to a child started by us and waits for it to exit, at most `timeoutMs`. */
export async function stopChild(
  child: ChildProcess | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
