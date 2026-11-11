import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineProject({
  resolve: {
    alias: {
      '@/': here('./src/'),
      'server-only': here('./test/support/empty.ts'),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/support/setup.ts'],
  },
})
