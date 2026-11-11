import type { Logger } from '@octobrief/application'

type Sink = (line: string) => void

/** One JSON line per entry, so logs can be shipped and queried as they are. */
export function createConsoleLogger(
  component: string,
  sink: Sink = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const write = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ time: now().toISOString(), level, component, message, ...fields }))
  return {
    info: (message, fields) => write('info', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}
