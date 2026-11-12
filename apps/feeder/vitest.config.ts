import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'feeder', include: ['test/**/*.test.ts'] },
})
