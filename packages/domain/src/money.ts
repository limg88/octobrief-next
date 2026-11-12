import { z } from 'zod'

// One currency for budgets, caps and spending: the euro. The providers price their models in US
// dollars per million tokens, as their price lists do; a dollar amount enters a budget only
// converted at the fixed USD→EUR rate the PMO Admin set, and every spending row keeps the rate it
// was converted with, so what a run cost can be told again whatever the rate becomes later. The
// fixed rate differs from the market's: the spending shown is a declared approximation.

/** The only currency of budgets, caps and spending. */
export const CURRENCY = 'EUR' as const

/** An amount in euro. */
export interface Eur {
  readonly eur: number
}

/** The fixed USD→EUR rate the Admin set: one dollar is worth `rate` euro. */
export interface UsdEurRate {
  readonly rate: number
  readonly setAt: Date
}

/** A rate the Admin may set: a positive number, at most 10 euro to the dollar. */
export const USD_EUR_RATE_MAX = 10

export const usdEurRateValueSchema = z.number().positive().max(USD_EUR_RATE_MAX)

/** The longest reason of a change of the rate, and the shortest. */
export const USD_EUR_RATE_REASON = { min: 20, max: 1000 } as const

const amount = z.number().min(0).max(1_000_000)

/** The price of a model, US dollars per million tokens, as the providers' price lists give it. */
export interface ModelPriceUsd {
  inputPerMillion: number
  outputPerMillion: number
}

export const modelPriceSchema = z.strictObject({
  inputPerMillion: amount,
  outputPerMillion: amount,
})

/**
 * How the Admin prices a model in `org_settings.model_prices`: dollars per million tokens, or
 * `{ "free": true }` for a model that costs nothing (a local backend), said explicitly. A model
 * with neither has no price: with a cap on cost or a budget, it does not run.
 */
export type ModelPricing = ModelPriceUsd | { free: true }

export const modelPricingSchema = z.union([
  modelPriceSchema,
  z.strictObject({ free: z.literal(true) }),
])

const ZERO: Eur = Object.freeze({ eur: 0 })

/** A dollar amount in euro, at the Admin's rate. */
export function toEur(usd: number, rate: UsdEurRate): Eur {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError('a dollar amount is a finite number ≥ 0')
  }
  if (!usdEurRateValueSchema.safeParse(rate.rate).success) {
    throw new RangeError('the USD→EUR rate is a positive number')
  }
  return { eur: usd * rate.rate }
}

/** The smallest amount written with its digits; anything spent below it reads «< 0,0001 €». */
const SMALLEST_SHOWN = 0.0001

/**
 * An amount in euro the way people read it: «0,0039 €», «12,50 €»; small amounts keep 4 digits,
 * and a cost above zero but below 0,0001 € reads «< 0,0001 €», never «0,0000 €».
 */
export function formatEur(value: Eur | number, locale = 'it-IT'): string {
  const eur = typeof value === 'number' ? value : value.eur
  const format = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: CURRENCY,
      minimumFractionDigits: 2,
      maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
    }).format(n)
  if (eur > 0 && eur < SMALLEST_SHOWN) return `< ${format(SMALLEST_SHOWN)}`
  return format(eur)
}

/**
 * What some tokens cost in euro: the dollar price of the model converted at the rate. A model
 * without a price (declared free) costs nothing; a price without a rate is never guessed.
 */
export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  priceUsd: ModelPriceUsd | null,
  rate: UsdEurRate | null,
): Eur {
  if (priceUsd === null) return ZERO
  if (rate === null) throw new RangeError('a dollar price needs the USD→EUR rate')
  return toEur(
    (usage.inputTokens * priceUsd.inputPerMillion +
      usage.outputTokens * priceUsd.outputPerMillion) /
      1_000_000,
    rate,
  )
}

/**
 * What a call the model did not answer costs: a paid backend may charge the request it received,
 * so the call counts its estimated input tokens, never zero. A backend declared free costs nothing.
 */
export function failedCallCost(
  estimatedInputTokens: number,
  priceUsd: ModelPriceUsd | null,
  rate: UsdEurRate | null,
): Eur {
  if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) {
    throw new RangeError('the estimated input tokens are a finite number ≥ 0')
  }
  return costOf({ inputTokens: estimatedInputTokens, outputTokens: 0 }, priceUsd, rate)
}
