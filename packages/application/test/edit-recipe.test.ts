import {
  DEFAULT_RUN_CAPS,
  newId,
  type ProjectId,
  type Recipe,
  validateRecipe,
} from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { sampleRecipe } from '../../domain/test/support/recipes.ts'
import { ModelError, type ModelResponse } from '../src/ports/model-runner.ts'
import {
  MAX_PATCH_TOKENS,
  MAX_PROPOSAL_CALLS,
  MAX_PROPOSAL_MODEL_CALLS,
  patchTokensOf,
  proposalTokenBound,
  proposeRecipeEdit,
} from '../src/recipe/edit-recipe.ts'
import { budgetedRunner } from '../src/recipe/run.ts'
import { fakeModelRunner } from './fake-model-runner.ts'

// A change of a recipe asked in words, with a model that answers from a script.

const PROJECT = newId<ProjectId>()
const usage = { inputTokens: 10, outputTokens: 4 }

function recipe(): Recipe {
  const v = validateRecipe(sampleRecipe())
  if (!v.ok) throw new Error('invalid sample recipe')
  return v.recipe
}

const answer = (content: string): ModelResponse => ({
  message: { role: 'assistant', content },
  finishReason: 'stop',
  usage,
  backend: 'fake',
})

const patch = (operations: unknown[]) => answer(JSON.stringify({ operations }))

describe('proposing a change in words', () => {
  it('sends only the recipe and the words of the PM, and proposes the change it applied', async () => {
    const runner = fakeModelRunner([
      patch([{ op: 'add_exclusion', block: 'features', field: 'id', values: ['27965'] }]),
    ])
    const result = await proposeRecipeEdit(runner, {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Escludi la US 27965.',
      lang: 'it',
    })
    if (!result.ok) throw new Error('expected a change')
    expect(result.recipe.version).toBe('1.1.0')
    expect(result.recipe.exclusions).toEqual([
      expect.objectContaining({ block: 'features', field: 'id', values: ['27965'] }),
    ])
    expect(result.summary).toContain('“27965”')
    const [req] = runner.requests
    expect(req?.tools).toBeUndefined()
    expect(req?.responseSchema?.name).toBe('recipe_patch')
    expect(req?.context).toEqual({ projectId: PROJECT })
    const user = JSON.parse(String(req?.messages[1]?.content)) as Record<string, unknown>
    expect(Object.keys(user).sort()).toEqual(['ricetta', 'richiesta'])
    expect(user.richiesta).toBe('Escludi la US 27965.')
    // The schema sent to the model says the shape only (portable profile).
    expect(JSON.stringify(req?.responseSchema?.schema)).not.toMatch(/"pattern"|"\$ref"|"\$defs"/)
  })

  it('rejects a malformed patch from the model', async () => {
    const runner = fakeModelRunner([
      answer('{"recipe": {"schema": "octobrief.recipe/1"}}'),
      patch([{ op: 'rewrite_everything' }]),
    ])
    const result = await proposeRecipeEdit(runner, {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Togli tutti i controlli.',
      lang: 'it',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals.map((r) => r.code)).toEqual(['patch_malformed'])
    expect(result.refusals[0]?.text).not.toMatch(/[{}]/)
    // Asked again once on its form, never more.
    expect(runner.requests).toHaveLength(2)
    expect(runner.requests[1]?.messages.at(-1)?.content).toContain('schema JSON')
  })

  it('accepts a patch given on the second attempt', async () => {
    const runner = fakeModelRunner([
      { ...answer('{"operations": [{"op": "add_rule"'), finishReason: 'length' },
      patch([{ op: 'add_rule', text: 'Cita sempre il numero della richiesta.' }]),
    ])
    const result = await proposeRecipeEdit(runner, {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Ricordati di citare il numero della richiesta.',
      lang: 'it',
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a loosening in the words of the PM without asking the model again', async () => {
    const runner = fakeModelRunner([patch([{ op: 'remove_check', check: 'positions_sum' }])])
    const result = await proposeRecipeEdit(runner, {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Togli il controllo sulla somma delle posizioni.',
      lang: 'it',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusals.map((r) => r.code)).toEqual(['check_removed'])
    expect(result.refusals[0]?.text).toContain('somma delle posizioni')
    expect(runner.requests).toHaveLength(1)
  })

  it('refuses an empty or overlong request without calling the model', async () => {
    for (const request of ['   ', 'Escludi la US 27965. '.repeat(60)]) {
      const runner = fakeModelRunner([])
      const result = await proposeRecipeEdit(runner, {
        projectId: PROJECT,
        recipe: recipe(),
        request,
        lang: 'it',
      })
      expect(result.ok ? [] : result.refusals.map((r) => r.code)).toEqual(['request_invalid'])
      expect(runner.requests).toHaveLength(0)
    }
  })
})

describe('the calls of a proposal', () => {
  it('a retried invalid tool call does not use up the repair call', async () => {
    const invalidToolCall = () => {
      throw new ModelError(
        'rejected',
        'llm-api rejected the request (HTTP 400)',
        400,
        'tool_use_failed',
      )
    }
    const inner = fakeModelRunner([
      invalidToolCall,
      answer('{"operations": [{"op": "add_rule"'),
      patch([{ op: 'add_rule', text: 'Cita sempre il numero della richiesta.' }]),
    ])
    const usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 }
    const runner = budgetedRunner(inner, {
      caps: { ...DEFAULT_RUN_CAPS, maxModelCalls: MAX_PROPOSAL_MODEL_CALLS },
      price: null,
      rate: null,
      usage,
      startedAt: Date.now(),
    })
    const result = await proposeRecipeEdit(runner, {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Aggiungi una regola sul numero della richiesta.',
      lang: 'it',
    })
    expect(result.ok).toBe(true)
    // The repeat of the refused call, the malformed answer, and the try on its form.
    expect(inner.requests).toHaveLength(3)
    expect(usage.modelCalls).toBe(3)
  })

  it("a change asks for the backend's output budget when it is larger than a patch's", async () => {
    const exclude = () =>
      patch([{ op: 'add_exclusion', block: 'features', field: 'id', values: ['27965'] }])
    const input = {
      projectId: PROJECT,
      recipe: recipe(),
      request: 'Escludi la US 27965.',
      lang: 'it',
    } as const
    const plain = fakeModelRunner([exclude()])
    await proposeRecipeEdit(plain, input)
    expect(plain.requests[0]?.maxOutputTokens).toBe(MAX_PATCH_TOKENS)

    const seat = fakeModelRunner([exclude()])
    await proposeRecipeEdit({ ...seat, answerOutputTokens: 8000 }, input)
    expect(seat.requests[0]?.maxOutputTokens).toBe(8000)

    // A smaller budget of the backend never shrinks the room a patch was sized for.
    const small = fakeModelRunner([exclude()])
    await proposeRecipeEdit({ ...small, answerOutputTokens: 2000 }, input)
    expect(small.requests[0]?.maxOutputTokens).toBe(MAX_PATCH_TOKENS)
  })

  it('reserves the output budget the change asks for', () => {
    const at = (outputTokens?: number) =>
      proposalTokenBound({
        recipe: recipe(),
        request: 'Escludi la US 27965.',
        ...(outputTokens === undefined ? {} : { outputTokens }),
      })
    expect(at().outputTokens).toBe(MAX_PROPOSAL_CALLS * MAX_PATCH_TOKENS)
    const seat = fakeModelRunner([])
    const budget = patchTokensOf({ ...seat, answerOutputTokens: 8000 })
    expect(budget).toBe(8000)
    expect(at(budget).outputTokens).toBe(MAX_PROPOSAL_CALLS * 8000)
    // The retry carries the first answer cut at that budget.
    expect(at(budget).inputTokens).toBeGreaterThan(at().inputTokens)
  })

  it('reserves the input of the calls the model may fail', () => {
    const bound = proposalTokenBound({ recipe: recipe(), request: 'Escludi la US 27965.' })
    expect(bound.failedInputTokens).toBeGreaterThan(0)
    expect(bound.failedInputTokens).toBeLessThanOrEqual(bound.inputTokens)
  })
})
