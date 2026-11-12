import { describe, expect, it } from 'vitest'
import {
  budgetAllowsCall,
  budgetAllowsRun,
  budgetAllowsSpend,
  canMoveRun,
  capReached,
  costOf,
  DEFAULT_RUN_CAPS,
  EMPTY_USAGE,
  modelPricingSchema,
  RUN_PHASES,
  RUN_STATUSES,
  runCapsSchema,
  runPhaseText,
  runPrice,
  runStatusText,
} from '../src/recipe/index.ts'

describe('run caps', () => {
  it('defaults to model calls that follow the recipe, 200,000 tokens and 30 minutes', () => {
    expect(DEFAULT_RUN_CAPS).toMatchObject({
      maxModelCalls: null,
      maxTokens: 200_000,
      maxDurationMinutes: 30,
    })
    expect(runCapsSchema.safeParse(DEFAULT_RUN_CAPS).success).toBe(true)
  })

  it('allows a call only while fewer calls than the cap were made', () => {
    const caps = { ...DEFAULT_RUN_CAPS, maxModelCalls: 3 }
    expect(capReached({ ...EMPTY_USAGE, modelCalls: 2 }, caps, 0)).toBeNull()
    expect(capReached({ ...EMPTY_USAGE, modelCalls: 3 }, caps, 0)).toBe('model_calls')
  })

  it('stops on tokens, time and the estimated cost', () => {
    const caps = { ...DEFAULT_RUN_CAPS, maxModelCalls: 20, maxCostPerRun: 0.5 }
    expect(
      capReached({ ...EMPTY_USAGE, inputTokens: 150_000, outputTokens: 50_000 }, caps, 0),
    ).toBe('tokens')
    expect(capReached(EMPTY_USAGE, caps, 30 * 60_000)).toBe('duration')
    expect(capReached({ ...EMPTY_USAGE, estimatedCost: 0.5 }, caps, 0)).toBe('cost')
    expect(capReached({ ...EMPTY_USAGE, estimatedCost: 0.49 }, caps, 0)).toBeNull()
  })

  it('estimates the cost from the price of the model, zero without one', () => {
    const tokens = { inputTokens: 1_000_000, outputTokens: 500_000 }
    const one = { rate: 1, setAt: new Date() }
    expect(costOf(tokens, { inputPerMillion: 0.2, outputPerMillion: 0.6 }, one).eur).toBeCloseTo(
      0.5,
    )
    expect(costOf(tokens, null, null).eur).toBe(0)
  })

  it('starts a run only when its cap on cost still fits in the budget of the project', () => {
    const caps = { ...DEFAULT_RUN_CAPS, projectBudget: 10, maxCostPerRun: 2 }
    expect(budgetAllowsRun(caps, 8)).toBe(true)
    expect(budgetAllowsRun(caps, 8.01)).toBe(false)
    expect(budgetAllowsRun(DEFAULT_RUN_CAPS, 1_000)).toBe(true)
    expect(budgetAllowsCall(caps, 9.99)).toBe(true)
    expect(budgetAllowsCall(caps, 10)).toBe(false)
  })

  it('starts other work of the project only when the most it may cost still fits', () => {
    const caps = { ...DEFAULT_RUN_CAPS, projectBudget: 10, maxCostPerRun: 2 }
    expect(budgetAllowsSpend(caps, 9.5, 0.5)).toBe(true)
    expect(budgetAllowsSpend(caps, 9.5, 0.51)).toBe(false)
    expect(budgetAllowsSpend(DEFAULT_RUN_CAPS, 1_000, 1_000)).toBe(true)
  })

  it('wants a cap on each run with a budget of the project', () => {
    expect(runCapsSchema.safeParse({ ...DEFAULT_RUN_CAPS, projectBudget: 10 }).success).toBe(false)
    expect(
      runCapsSchema.safeParse({ ...DEFAULT_RUN_CAPS, projectBudget: 10, maxCostPerRun: 1 }).success,
    ).toBe(true)
  })

  it('refuses a model without a price when cost is capped, unless it is declared free', () => {
    const capped = { ...DEFAULT_RUN_CAPS, projectBudget: 10, maxCostPerRun: 1 }
    const rate = { rate: 0.9, setAt: new Date() }
    expect(runPrice(null, capped, rate)).toEqual({ missing: 'price' })
    expect(runPrice(null, { ...DEFAULT_RUN_CAPS, maxCostPerRun: 1 }, rate)).toEqual({
      missing: 'price',
    })
    expect(runPrice(null, DEFAULT_RUN_CAPS, null)).toEqual({ price: null, rate: null })
    expect(runPrice({ free: true }, capped, null)).toEqual({ price: null, rate: null })
    const price = { inputPerMillion: 1, outputPerMillion: 2 }
    expect(runPrice(price, capped, rate)).toEqual({ price, rate })
    expect(modelPricingSchema.safeParse({ free: false }).success).toBe(false)
  })

  it('refuses a priced model while the admin set no dollar rate, capped or not', () => {
    const price = { inputPerMillion: 1, outputPerMillion: 2 }
    expect(runPrice(price, DEFAULT_RUN_CAPS, null)).toEqual({ missing: 'rate' })
    expect(runPrice(price, { ...DEFAULT_RUN_CAPS, maxCostPerRun: 1 }, null)).toEqual({
      missing: 'rate',
    })
  })

  it('refuses caps beyond the hard maxima', () => {
    expect(runCapsSchema.safeParse({ ...DEFAULT_RUN_CAPS, maxModelCalls: 1_000 }).success).toBe(
      false,
    )
    expect(runCapsSchema.safeParse({ ...DEFAULT_RUN_CAPS, extra: 1 }).success).toBe(false)
  })
})

describe('run states', () => {
  it('moves forward only and never back from a discard', () => {
    expect(canMoveRun('queued', 'running')).toBe(true)
    expect(canMoveRun('ready', 'running')).toBe(true)
    expect(canMoveRun('ready', 'queued')).toBe(false)
    expect(canMoveRun('failed', 'running')).toBe(false)
    for (const s of RUN_STATUSES) expect(canMoveRun('discarded', s)).toBe(false)
  })

  it('tells every phase and state in the words of a PM', () => {
    for (const p of RUN_PHASES) expect(runPhaseText(p, 'it')).not.toMatch(/[_{}]/)
    for (const s of RUN_STATUSES) expect(runStatusText(s, 'it')).not.toMatch(/[_{}]/)
    expect(runPhaseText('gathering', 'it')).toBe('Raccolgo i dati delle fonti')
  })
})
