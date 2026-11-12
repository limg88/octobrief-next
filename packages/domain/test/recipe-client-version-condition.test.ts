import { describe, expect, it } from 'vitest'
import {
  diffRecipes,
  hasClientVersion,
  recipeText,
  settingsErrorText,
  validateProjectRecipeSettings,
  validateRecipe,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'
import { cleanDraft, redTeam, redTeamContext } from './support/red-team.ts'

// A recipe for both versions can give the client version only when the PM says so with a choice:
// without that answer the deliverable is internal only (the restrictive default).

function raw(when: Record<string, unknown> | null = { parameter: 'sprint', equals: 'current' }) {
  const r = sampleRecipe()
  if (when !== null) r.clientVersionWhen = when
  return r
}

const codes = (r: Record<string, unknown>) => {
  const v = validateRecipe(r)
  return v.ok ? [] : v.errors.map((e) => e.code)
}

describe('the condition of the client version', () => {
  it('is a choice of the PM on a recipe for both versions', () => {
    expect(codes(raw())).toEqual([])
    expect(codes(raw({ parameter: 'nowhere', equals: 'current' }))).toEqual(['parameter_unknown'])
    expect(codes(raw({ parameter: 'period', equals: 'current' }))).toEqual(['parameter_wrong_type'])
    expect(codes(raw({ parameter: 'sprint', equals: 'never' }))).toEqual([
      'client_version_condition_invalid',
    ])
    expect(codes(raw({ parameter: 'sprint' }))).toEqual(['recipe_malformed'])
    const forClient = raw()
    forClient.audience = 'client'
    expect(codes(forClient)).toEqual(['client_version_condition_invalid'])
    // The recipients of a mail never decide anything.
    expect(recipeText('errors', 'client_version_condition_invalid', {}, 'it')).not.toBe('')
  })

  it('gives the client version only for the typed answer that asks for it', () => {
    const recipe = recipeOf(raw())
    expect(hasClientVersion(recipe, { sprint: { type: 'choice', value: 'current' } })).toBe(true)
    expect(hasClientVersion(recipe, { sprint: { type: 'choice', value: 'previous' } })).toBe(false)
    expect(hasClientVersion(recipe, {})).toBe(false)
    // Only the typed value a run stores counts: a bare string is not an answer.
    expect(hasClientVersion(recipe, { sprint: 'current' })).toBe(false)
    // Without a condition, the audience of the recipe decides.
    expect(hasClientVersion(recipeOf(raw(null)), {})).toBe(true)
    const internal = raw(null)
    internal.audience = 'internal'
    internal.sections = internal.sections.filter((s) => s.version !== 'client')
    expect(hasClientVersion(recipeOf(internal), {})).toBe(false)
  })

  it('shows a change of the condition in the differences', () => {
    const before = recipeOf(raw(null))
    const after = recipeOf(raw())
    expect(diffRecipes(before, after, 'it').map((c) => c.code)).toEqual([
      'client_version_condition_changed',
    ])
  })

  it('never lets the red-team skip the client version of a recipe that always has one', () => {
    const { client: _client, ...noClient } = redTeamContext()
    // The sample recipe has no condition: without its client version the red-team refuses.
    expect(() => redTeam(cleanDraft(), { ...noClient, withoutClientVersion: true })).toThrow(
      'red_team_without_client_version',
    )
    // With a condition, a run the PM kept internal is judged without it; never with both.
    const conditioned = recipeOf(raw())
    expect(() =>
      redTeam(cleanDraft(), { ...noClient, recipe: conditioned, withoutClientVersion: true }),
    ).not.toThrow()
    expect(() =>
      redTeam(cleanDraft(), {
        ...redTeamContext({ recipe: conditioned }),
        withoutClientVersion: true,
      }),
    ).toThrow('red_team_without_client_version')
  })
})

describe('the client version as a default of the project', () => {
  const settings = (value: string) =>
    validateProjectRecipeSettings(recipeOf(raw()), {
      parameterDefaults: { sprint: value },
      templateRef: null,
      mapping: null,
      labels: {},
    })

  it('is refused: the PM asks for the client version run by run', () => {
    const v = settings('current')
    expect(v.ok ? [] : v.errors.map((e) => e.code)).toEqual(['client_version_by_default'])
    if (v.ok) return
    expect(settingsErrorText(v.errors[0] as never, 'it')).toBe(
      recipeText('patch', 'client_version_by_default', { name: 'SAL economico' }, 'it'),
    )
    expect(settings('previous').ok).toBe(true)
  })
})
