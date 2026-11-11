// Starts the worker, the web app and, with a loopback issuer, the fake OpenID Connect issuer.
// Ctrl+C stops them all.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../.env.local', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)
const issuer = process.env.OIDC_ISSUER
const localIssuer = issuer !== undefined && new URL(issuer).hostname === '127.0.0.1'

const children: ChildProcess[] = [
  ...(localIssuer
    ? [spawn('pnpm', ['--filter', '@octobrief/fake-oidc', 'start'], { stdio: 'inherit' })]
    : []),
  spawn('pnpm', ['--filter', '@octobrief/worker', 'start'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@octobrief/web', 'dev'], { stdio: 'inherit' }),
]

function stopAll(code: number): void {
  for (const child of children) child.kill('SIGTERM')
  process.exitCode = code
}

process.on('SIGINT', () => stopAll(0))
process.on('SIGTERM', () => stopAll(0))
for (const child of children) child.on('exit', (code) => stopAll(code ?? 0))
