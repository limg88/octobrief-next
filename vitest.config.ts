import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/worker'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      // Composition roots (main.ts, web container and routes) are exercised by the demos and e2e.
      exclude: ['**/index.ts', '**/main.ts', 'apps/web/src/app/**', 'apps/web/src/server/**'],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
