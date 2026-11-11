// Runs a command with the repository's .env.local loaded (when present). WEB_PORT becomes PORT.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../.env.local', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)
process.env.PORT ??= process.env.WEB_PORT ?? '3310'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: with-env.ts <command> [args…]')
  process.exit(2)
}
const child = spawn(command, args, { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code) => process.exit(code ?? 0))
