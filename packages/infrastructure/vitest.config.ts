import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Integration tests use the development database described in .env.local (pnpm db:setup).
const envFile = fileURLToPath(new URL('../../.env.local', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

export default defineConfig({
  test: { name: 'infrastructure', include: ['test/**/*.test.ts'], testTimeout: 20_000 },
})
