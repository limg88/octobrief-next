import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'fake-oidc', include: ['test/**/*.test.ts'] },
})
