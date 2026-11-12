import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/worker', 'apps/feeder', 'apps/web', 'tools/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}', 'tools/*/src/**/*.ts'],
      // Composition roots and framework wiring (main.ts, cli.ts, Next routes, proxy, i18n config,
      // fonts) are exercised by the demos; components/ui holds vendored shadcn primitives.
      exclude: [
        '**/index.ts',
        '**/main.ts',
        '**/cli.ts',
        'apps/web/src/app/**',
        'apps/web/src/server/**',
        'apps/web/src/proxy.ts',
        'apps/web/src/i18n/**',
        'apps/web/src/font/**',
        'apps/web/src/components/ui/**',
      ],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
