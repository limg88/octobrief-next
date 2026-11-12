import { describe, expect, it } from 'vitest'
import {
  CURRENCY,
  costOf,
  failedCallCost,
  formatEur,
  modelPricingSchema,
  toEur,
  usdEurRateValueSchema,
} from '../src/recipe/index.ts'

const rate = { rate: 0.9, setAt: new Date('2026-11-07T09:00:00Z') }
/** Spaces as people read them: Intl puts a no-break space before the euro sign. */
const plain = (s: string) => s.replace(/\s/g, ' ')

describe('money', () => {
  it('has one currency, the euro', () => {
    expect(CURRENCY).toBe('EUR')
  })

  it("a dollar price becomes euros at the admin's rate", () => {
    expect(toEur(10, rate).eur).toBeCloseTo(9)
    const price = { inputPerMillion: 0.59, outputPerMillion: 0.79 }
    const cost = costOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, price, rate)
    // (0.59 + 0.395) $ at 0.9 €/$.
    expect(cost.eur).toBeCloseTo(0.8865)
    expect(
      costOf({ inputTokens: 1_000_000, outputTokens: 0 }, price, { ...rate, rate: 1 }).eur,
    ).toBeCloseTo(0.59)
  })

  it('never guesses a rate: a dollar price without one is refused', () => {
    const price = { inputPerMillion: 1, outputPerMillion: 1 }
    expect(() => costOf({ inputTokens: 1, outputTokens: 1 }, price, null)).toThrow(RangeError)
    expect(() => toEur(1, { rate: 0, setAt: new Date() })).toThrow(RangeError)
    expect(() => toEur(-1, rate)).toThrow(RangeError)
  })

  it('costs nothing for a model declared free', () => {
    expect(costOf({ inputTokens: 5_000, outputTokens: 5_000 }, null, null).eur).toBe(0)
  })

  it('a failed paid call is charged its estimated input', () => {
    const price = { inputPerMillion: 2, outputPerMillion: 8 }
    const cost = failedCallCost(10_000, price, rate)
    // 10,000 tokens at 2 $ per million, at 0.9 €/$: input only, never zero.
    expect(cost.eur).toBeCloseTo(0.018)
    expect(cost.eur).toBeGreaterThan(0)
  })

  it('a failed call on a free backend costs nothing', () => {
    expect(failedCallCost(10_000, null, null).eur).toBe(0)
    expect(failedCallCost(10_000, null, rate).eur).toBe(0)
  })

  it('writes euros the Italian way, small amounts with four digits', () => {
    expect(plain(formatEur({ eur: 0.0039 }))).toBe('0,0039 €')
    expect(plain(formatEur(12.5))).toBe('12,50 €')
    expect(plain(formatEur({ eur: 0.5 }))).toBe('0,50 €')
    expect(plain(formatEur(0))).toBe('0,00 €')
  })

  it('never writes a tiny cost above zero as zero', () => {
    expect(plain(formatEur({ eur: 0.000002 }))).toBe('< 0,0001 €')
    expect(plain(formatEur({ eur: 0.0001 }))).toBe('0,0001 €')
  })

  it('accepts only a positive rate within its maximum, and prices in dollars or free', () => {
    expect(usdEurRateValueSchema.safeParse(0.92).success).toBe(true)
    for (const bad of [0, -1, 11, Number.NaN]) {
      expect(usdEurRateValueSchema.safeParse(bad).success).toBe(false)
    }
    expect(modelPricingSchema.safeParse({ free: true }).success).toBe(true)
    expect(modelPricingSchema.safeParse({ inputPerMillion: 1, outputPerMillion: 2 }).success).toBe(
      true,
    )
  })
})
