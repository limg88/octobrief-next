import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'synthetic', include: ['test/**/*.test.ts'] },
})
