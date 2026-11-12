import { describe, expect, it } from 'vitest'
import {
  applyRecipePatch,
  type PatchResult,
  type Recipe,
  type RecipeCheck,
  recipeLoosenings,
} from '../src/recipe/index.ts'
import { productRecipe } from './support/product-recipes.ts'

// A change in words only tightens a recipe: it never makes the version for the client less
// guarded than the PM's explicit choice, and never weakens the checks on the sources of a text
// or on the agreement of two sources.

const minutes = (): Recipe => productRecipe('minutes-from-transcript.json')
const salEconomico = (): Recipe => productRecipe('sal-economico.json')

function refused(result: PatchResult) {
  if (result.ok) throw new Error('expected a refusal')
  return result.refusals
}

function accepted(result: PatchResult) {
  if (!result.ok) throw new Error(`expected a change: ${JSON.stringify(result.refusals)}`)
  return result
}

/** A text for the PM: no JSON, no identifier of the recipe, no placeholder left. */
function expectPmWords(text: string): void {
  expect(text).not.toMatch(/[{}[\]]/)
  expect(text).not.toMatch(/clientVersionWhen|for_client|transcript|_located|_assigned/)
  expect(text.length).toBeGreaterThan(10)
}

function withCheck(r: Recipe, id: string, change: (c: RecipeCheck) => RecipeCheck): Recipe {
  const after = structuredClone(r)
  after.checks = after.checks.map((c) => (c.id === id ? change(structuredClone(c)) : c))
  return after
}

describe('the choice that gives a deliverable its client version', () => {
  it('refuses to remove the condition, so every run would have a client version', () => {
    const before = minutes()
    const after = structuredClone(before)
    delete after.clientVersionWhen
    const refusals = recipeLoosenings(before, after, 'it')
    expect(refusals.map((r) => r.code)).toContain('client_version_condition_changed')
    for (const r of refusals) expectPmWords(r.text)
  })

  it('refuses to change the option that asks for the client version', () => {
    const before = minutes()
    const after = structuredClone(before)
    after.clientVersionWhen = { parameter: 'for_client', equals: 'no' }
    expect(recipeLoosenings(before, after, 'it').map((r) => r.code)).toContain(
      'client_version_condition_changed',
    )
  })

  it('refuses to make the condition depend on another choice', () => {
    const before = minutes()
    const after = structuredClone(before)
    after.clientVersionWhen = { parameter: 'previous_minutes', equals: 'yes' }
    expect(recipeLoosenings(before, after, 'it').map((r) => r.code)).toContain(
      'client_version_condition_changed',
    )
  })

  it('accepts a condition added to a recipe of both versions: it only restricts', () => {
    const after = minutes()
    const before = structuredClone(after)
    delete before.clientVersionWhen
    expect(recipeLoosenings(before, after, 'it').map((r) => r.code)).not.toContain(
      'client_version_condition_changed',
    )
  })

  it('refuses to make the client version the default of the project', () => {
    const op = { op: 'set_parameter_default', parameter: 'for_client', value: 'yes' }
    const refusals = refused(applyRecipePatch(minutes(), { operations: [op] }, 'it'))
    expect(refusals.map((r) => r.code)).toEqual(['client_version_by_default'])
    for (const r of refusals) expectPmWords(r.text)
  })

  it('accepts «internal only» as the default of the project', () => {
    const op = { op: 'set_parameter_default', parameter: 'for_client', value: 'no' }
    const result = accepted(applyRecipePatch(minutes(), { operations: [op] }, 'it'))
    expect(result.parameterDefaults).toEqual({ for_client: 'no' })
  })
})

describe('checks on the sources of a text', () => {
  it('refuses to remove a check that every action has its fields', () => {
    const op = { op: 'remove_check', check: 'actions_assigned' }
    const refusals = refused(applyRecipePatch(minutes(), { operations: [op] }, 'it'))
    expect(refusals.map((r) => r.code)).toContain('check_removed')
  })

  it('refuses to let a cited segment point anywhere but the chosen transcript', () => {
    const before = minutes()
    const after = withCheck(before, 'decisions_located', (c) => {
      if (c.kind !== 'segments_cited') throw new Error('expected a segment check')
      delete c.parameter
      return c
    })
    expect(recipeLoosenings(before, after, 'it').map((r) => r.code)).toEqual(['check_weakened'])
  })

  it('refuses to widen the kinds of source a segment may cite', () => {
    const before = minutes()
    const after = withCheck(before, 'decisions_located', (c) => {
      if (c.kind !== 'segments_cited') throw new Error('expected a segment check')
      return { ...c, sourceKinds: ['evidence', 'fact'] }
    })
    expect(recipeLoosenings(before, after, 'it').map((r) => r.code)).toEqual(['check_weakened'])
  })

  it('refuses to drop a field an action must state, or to widen its sources', () => {
    const before = minutes()
    const fewer = withCheck(before, 'actions_assigned', (c) => {
      if (c.kind !== 'segment_fields') throw new Error('expected a fields check')
      return { ...c, fields: c.fields.slice(0, 1) }
    })
    expect(recipeLoosenings(before, fewer, 'it').map((r) => r.code)).toEqual(['check_weakened'])
    const wider = withCheck(before, 'actions_assigned', (c) => {
      if (c.kind !== 'segment_fields') throw new Error('expected a fields check')
      const { parameter: _dropped, ...rest } = c
      return { ...rest, sourceKinds: ['evidence', 'parameter'] }
    })
    expect(recipeLoosenings(before, wider, 'it').map((r) => r.code)).toEqual(['check_weakened'])
  })
})

describe('checks on the agreement of two sources', () => {
  it('refuses to compare an invoice against itself, or to loosen a closing to 100%', () => {
    const before = salEconomico()
    const self = withCheck(before, 'invoices_agree', (c) => {
      if (c.kind !== 'agree_by_key') throw new Error('expected an agreement check')
      return { ...c, right: { ...c.left } }
    })
    expect(recipeLoosenings(before, self, 'it').map((r) => r.code)).toEqual(['check_weakened'])
    const lower = withCheck(before, 'closing_complete', (c) => {
      if (c.kind !== 'all_equal_when') throw new Error('expected a closing check')
      return { ...c, equals: 90 }
    })
    expect(recipeLoosenings(before, lower, 'it').map((r) => r.code)).toEqual(['check_weakened'])
    const removed = refused(
      applyRecipePatch(
        before,
        { operations: [{ op: 'remove_check', check: 'invoices_agree' }] },
        'it',
      ),
    )
    expect(removed.map((r) => r.code)).toContain('check_removed')
  })
})
