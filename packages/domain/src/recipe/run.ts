import { z } from 'zod'
import type { Lang } from '../language/index.ts'
import type { ModelPriceUsd, ModelPricing, UsdEurRate } from '../money.ts'
import type { Recipe } from './format.ts'
import { MAX_RUN_DURATION_MINUTES, MODEL_TIMEOUT_SECONDS } from './limits.ts'
import { recipeText } from './messages/index.ts'

export { MAX_RUN_DURATION_MINUTES, MODEL_TIMEOUT_SECONDS }

// The run of a recipe: its states, its phases told in the words of a PM, and its caps. One budget
// of model calls covers the writer, its tool turns, the retry on the form, the reviewer and the
// automatic cycle; tokens, the estimated cost and the time are capped as well. Past a cap the run
// stops with a message for the PM, never with a partial draft shown as complete.

export const RUN_STATUSES = ['queued', 'running', 'ready', 'failed', 'discarded'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const RUN_PHASES = ['gathering', 'writing', 'checking', 'revising'] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/** Where a status may go: forward only; a discarded run never comes back. */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'failed', 'discarded'],
  running: ['ready', 'failed', 'discarded'],
  // A revision (the automatic cycle, a request of the PM) runs the draft again.
  ready: ['running', 'discarded'],
  failed: ['discarded'],
  discarded: [],
}

export function canMoveRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/** The caps of one run and the budget of a project, as the Admin set them. */
export interface RunCaps {
  /**
   * Model calls of a run, the tool turns of the writer included; null: «automatico», the number
   * follows the recipe (`runCapsForRecipe`).
   */
  maxModelCalls: number | null
  /** Input plus output tokens of a run. */
  maxTokens: number
  maxDurationMinutes: number
  /** Euro; null: no cap on the estimated cost of a run. */
  maxCostPerRun: number | null
  /** Euro a project may spend on runs; null: no budget set. */
  projectBudget: number | null
}

/** The caps a run actually runs with: a number of model calls, always. */
export type ResolvedRunCaps = Omit<RunCaps, 'maxModelCalls'> & { maxModelCalls: number }

/** The defaults: model calls that follow the recipe, 200,000 tokens, 30 minutes. */
export const DEFAULT_RUN_CAPS: Readonly<RunCaps> = Object.freeze({
  maxModelCalls: null,
  maxTokens: 200_000,
  maxDurationMinutes: 30,
  maxCostPerRun: null,
  projectBudget: null,
})

/** The most model calls a run may ever make, whoever sets the caps. */
export const MAX_RUN_MODEL_CALLS = 100

/**
 * The model calls a run of a recipe needs: each text slot takes a turn of the tools and a
 * structured answer, the reviewer one call more; the one automatic cycle may write every slot
 * and review again, so `needed` is twice that. `withMargin` adds one call per slot, for a second
 * reading or the one retry on the form of an answer.
 */
export function recipeModelCalls(recipe: Recipe): { needed: number; withMargin: number } {
  const slots = recipe.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.kind === 'text_slot').length
  const draft = 2 * slots + (recipe.redTeamRules.length > 0 ? 1 : 0)
  return { needed: 2 * draft, withMargin: 2 * draft + slots }
}

/** The fewest model calls an automatic cap gives a run, whatever the recipe. */
export const AUTOMATIC_MIN_MODEL_CALLS = 20

export type RunCapsForRecipe =
  | { ok: true; caps: ResolvedRunCaps }
  /** The number the Admin set is lower than what the recipe needs. */
  | { ok: false; code: 'calls_cap_too_low'; needed: number; cap: number }
  /** The recipe needs more than any run may make: nobody's setting is at fault. */
  | { ok: false; code: 'calls_beyond_maximum'; needed: number; cap: number }

/**
 * The caps a run of this recipe starts with. With the number of model calls automatic (null)
 * the run gets what the recipe needs with its margin, never less than
 * `AUTOMATIC_MIN_MODEL_CALLS` nor more than `MAX_RUN_MODEL_CALLS`; a number the Admin set stays
 * the ceiling. A recipe that needs more is refused before it starts, never stopped halfway.
 * Every other cap is the organisation's.
 */
export function runCapsForRecipe(recipe: Recipe, caps: RunCaps): RunCapsForRecipe {
  const calls = recipeModelCalls(recipe)
  if (caps.maxModelCalls === null) {
    if (calls.needed > MAX_RUN_MODEL_CALLS) {
      return {
        ok: false,
        code: 'calls_beyond_maximum',
        needed: calls.needed,
        cap: MAX_RUN_MODEL_CALLS,
      }
    }
    const derived = Math.min(
      MAX_RUN_MODEL_CALLS,
      Math.max(AUTOMATIC_MIN_MODEL_CALLS, calls.withMargin),
    )
    return { ok: true, caps: { ...caps, maxModelCalls: derived } }
  }
  if (calls.needed > caps.maxModelCalls) {
    return { ok: false, code: 'calls_cap_too_low', needed: calls.needed, cap: caps.maxModelCalls }
  }
  return { ok: true, caps: { ...caps, maxModelCalls: caps.maxModelCalls } }
}

/** An amount in euro (`CURRENCY`): caps and budgets. */
const euro = z.number().min(0).max(1_000_000)

export type ModelTimeouts = Record<string, number>

export const modelTimeoutsSchema = z.record(
  z.string().min(1).max(200),
  z.int().min(MODEL_TIMEOUT_SECONDS.min).max(MODEL_TIMEOUT_SECONDS.max),
)

/** The time one call of `model` may take, in milliseconds. */
export function modelCallTimeoutMs(timeouts: Readonly<ModelTimeouts>, model: string): number {
  const seconds = Object.hasOwn(timeouts, model) ? timeouts[model] : undefined
  return (seconds ?? MODEL_TIMEOUT_SECONDS.default) * 1000
}

/** What the database stores: every cap within a hard maximum, never a looser shape. */
export const runCapsSchema = z
  .strictObject({
    maxModelCalls: z.int().min(1).max(MAX_RUN_MODEL_CALLS).nullable(),
    maxTokens: z.int().min(1_000).max(2_000_000),
    maxDurationMinutes: z.int().min(1).max(MAX_RUN_DURATION_MINUTES),
    maxCostPerRun: euro.nullable(),
    projectBudget: euro.nullable(),
  })
  // A budget needs a cap on each run: a queued or running run reserves that cap, never nothing.
  .refine((c) => c.projectBudget === null || c.maxCostPerRun !== null, {
    path: ['maxCostPerRun'],
    message: 'a project budget needs a cap on the cost of a run',
  })

/**
 * The price a run is estimated with: the dollar price of the model with the Admin's USD→EUR rate,
 * nothing for a model declared free. Missing `price` when the model has no price and a cap on
 * cost or a budget must be held; missing `rate` when the model has a price but the Admin set no
 * rate: a dollar amount never enters a budget in euro unconverted.
 */
export function runPrice(
  pricing: ModelPricing | null,
  caps: RunCaps,
  rate: UsdEurRate | null,
): { price: ModelPriceUsd | null; rate: UsdEurRate | null } | { missing: 'price' | 'rate' } {
  if (pricing !== null) {
    if ('free' in pricing) return { price: null, rate: null }
    return rate === null ? { missing: 'rate' } : { price: pricing, rate }
  }
  if (caps.maxCostPerRun === null && caps.projectBudget === null) {
    return { price: null, rate: null }
  }
  return { missing: 'price' }
}

/** What a run used so far. */
export interface RunUsage {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  /**
   * Euro, from the dollar price of the model at the Admin's rate, failed calls counted at their
   * estimated input; 0 for a model the Admin declared free.
   */
  estimatedCost: number
}

export const EMPTY_USAGE: Readonly<RunUsage> = Object.freeze({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCost: 0,
})

export const RUN_CAPS_REACHED = ['model_calls', 'tokens', 'duration', 'cost'] as const
export type RunCapReached = (typeof RUN_CAPS_REACHED)[number]

/**
 * The first cap the usage has reached, or null. A call is allowed only while fewer calls than the
 * cap were made, so the check runs before every call; tokens and cost are judged on what the
 * calls so far used.
 */
export function capReached(
  usage: RunUsage,
  caps: ResolvedRunCaps,
  elapsedMs: number,
): RunCapReached | null {
  if (usage.modelCalls >= caps.maxModelCalls) return 'model_calls'
  if (usage.inputTokens + usage.outputTokens >= caps.maxTokens) return 'tokens'
  if (elapsedMs >= caps.maxDurationMinutes * 60_000) return 'duration'
  if (caps.maxCostPerRun !== null && usage.estimatedCost >= caps.maxCostPerRun) return 'cost'
  return null
}

/**
 * Whether a project may start a run: with a budget, what the other runs spent or reserved plus
 * the most this run may spend (its cap on cost) fits in it.
 */
export function budgetAllowsRun(caps: RunCaps, projectSpent: number): boolean {
  if (caps.projectBudget === null) return true
  return projectSpent + (caps.maxCostPerRun ?? caps.projectBudget) <= caps.projectBudget
}

/**
 * Whether some work of the project that may cost at most `reserved` (a change of a recipe asked in
 * words) can start: with a budget, what the runs and the other work spent or reserved plus it fits.
 */
export function budgetAllowsSpend(caps: RunCaps, projectSpent: number, reserved: number): boolean {
  return caps.projectBudget === null || projectSpent + reserved <= caps.projectBudget
}

/** Whether a running run may make one more call: what the project spent is still under budget. */
export function budgetAllowsCall(caps: RunCaps, projectSpent: number): boolean {
  return caps.projectBudget === null || projectSpent < caps.projectBudget
}

export type RunTextKey = `phase_${RunPhase}` | `status_${RunStatus}` | 'suspended_data'

/** The phase of a run in the words of a PM. */
export function runPhaseText(phase: RunPhase, lang: Lang): string {
  return recipeText('run', `phase_${phase}`, {}, lang)
}

/** The state of a run in the words of a PM. */
export function runStatusText(status: RunStatus, lang: Lang): string {
  return recipeText('run', `status_${status}`, {}, lang)
}
