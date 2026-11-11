// Starts the worker and the web app together; Ctrl+C stops both.
import { type ChildProcess, spawn } from 'node:child_process'

const children: ChildProcess[] = [
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
