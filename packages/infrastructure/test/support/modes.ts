import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./spin-child.ts', import.meta.url))
/** Options pointing the extraction at the test-only hostile child (the mode is an extra argument). */
export const hostile = (mode: string, extra: { timeoutMs?: number } = {}) => ({
  childEntry: entry,
  childArgs: [mode],
  ...extra,
})
