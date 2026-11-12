import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RUN_CAPS,
  MAX_RUN_DURATION_MINUTES,
  MODEL_TIMEOUT_SECONDS,
  modelCallTimeoutMs,
  modelTimeoutsSchema,
  runCapsSchema,
} from '../src/recipe/index.ts'

describe('the time a model call may take', () => {
  it('waits 80 seconds for a model without its own time, the time the Admin set otherwise', () => {
    expect(MODEL_TIMEOUT_SECONDS).toEqual({ min: 10, max: 120, default: 80 })
    expect(modelCallTimeoutMs({}, 'ollama/tools')).toBe(80_000)
    expect(modelCallTimeoutMs({ 'ollama/tools': 115 }, 'ollama/tools')).toBe(115_000)
    expect(modelCallTimeoutMs({ 'ollama/tools': 115 }, 'groq/gpt-oss-20b')).toBe(80_000)
  })

  it('accepts whole seconds from 10 to 120, the limit of the gateway, for models with a name, nothing else', () => {
    expect(modelTimeoutsSchema.safeParse({}).success).toBe(true)
    expect(modelTimeoutsSchema.safeParse({ a: 10, b: 120 }).success).toBe(true)
    expect(modelTimeoutsSchema.safeParse({ a: 9 }).success).toBe(false)
    expect(modelTimeoutsSchema.safeParse({ a: 121 }).success).toBe(false)
    expect(modelTimeoutsSchema.safeParse({ a: 80.5 }).success).toBe(false)
    expect(modelTimeoutsSchema.safeParse({ a: '80' }).success).toBe(false)
    expect(modelTimeoutsSchema.safeParse({ '': 80 }).success).toBe(false)
    expect(modelTimeoutsSchema.safeParse([80]).success).toBe(false)
  })
})

describe('the duration cap of a run', () => {
  it('may be raised up to 120 minutes, the default staying 30', () => {
    expect(MAX_RUN_DURATION_MINUTES).toBe(120)
    expect(DEFAULT_RUN_CAPS.maxDurationMinutes).toBe(30)
    const caps = (m: number) => ({ ...DEFAULT_RUN_CAPS, maxDurationMinutes: m })
    expect(runCapsSchema.safeParse(caps(120)).success).toBe(true)
    expect(runCapsSchema.safeParse(caps(121)).success).toBe(false)
    expect(runCapsSchema.safeParse(caps(0)).success).toBe(false)
  })
})
