import { describe, expect, it } from 'vitest'
import { COMPILE_MAX_TOKENS } from '../src/knowledge/compile.ts'
import { MAX_ANSWER_TOKENS } from '../src/ports/model-runner.ts'
import { MAX_PATCH_TOKENS, proposalTokenBound } from '../src/recipe/edit-recipe.ts'

/**
 * Output tokens of the final turn of the Claude seat in the gateway's real trial (a structured
 * answer after two readings), its reasoning included: 791 out of a budget of 1000.
 */
const SEAT_STRUCTURED_TURN_TOKENS = 791

/**
 * The output each structured turn was sized for before a backend counted its reasoning in the
 * same budget: the contract alone, at its fullest.
 */
const CONTRACT_TOKENS = {
  answer: 1500,
  compile: 4000,
  patch: 3000,
} as const

/** Room at least twice the expected output: an answer that reaches the budget is refused. */
const HEADROOM = 2

describe('the output budget of a structured turn', () => {
  it("a structured answer has room for the model's reasoning", () => {
    const caps = { answer: MAX_ANSWER_TOKENS, compile: COMPILE_MAX_TOKENS, patch: MAX_PATCH_TOKENS }
    for (const [turn, cap] of Object.entries(caps)) {
      expect(cap, turn).toBeGreaterThanOrEqual(
        HEADROOM * CONTRACT_TOKENS[turn as keyof typeof CONTRACT_TOKENS],
      )
      expect(cap, turn).toBeGreaterThanOrEqual(HEADROOM * SEAT_STRUCTURED_TURN_TOKENS)
    }
  })

  it('the reservation of a change of a recipe follows its larger output budget', () => {
    const bound = proposalTokenBound({
      recipe: {} as Parameters<typeof proposalTokenBound>[0]['recipe'],
      request: 'Aggiungi una sezione sui rischi aperti.',
    })
    expect(bound.outputTokens).toBeGreaterThanOrEqual(2 * MAX_PATCH_TOKENS)
  })
})
