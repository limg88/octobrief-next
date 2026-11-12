import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// End-to-end tests of the key flows, in a real browser against the real stack: web, worker,
// fake issuer and the fake model (no network). Needs `pnpm db:setup` once.
const envFile = fileURLToPath(new URL('../.env.local', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)
const baseURL = process.env.PUBLIC_URL ?? 'http://127.0.0.1:3310'

export default defineConfig({
  testDir: '.',
  outputDir: '../.tmp/e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // One flow at a time: the tests share a database and a worker.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL, locale: 'it-IT', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
