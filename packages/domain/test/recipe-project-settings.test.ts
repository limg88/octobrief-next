import { describe, expect, it } from 'vitest'
import {
  effectiveProjectRecipe,
  type Recipe,
  settingsErrorText,
  validateProjectRecipeSettings,
  validateRecipe,
} from '../src/recipe/index.ts'
import { sampleRecipe } from './support/recipes.ts'

const recipe = (): Recipe => {
  const v = validateRecipe(sampleRecipe())
  if (!v.ok) throw new Error(JSON.stringify(v.errors))
  return v.recipe
}

const empty = { parameterDefaults: {}, templateRef: null, mapping: null, labels: {} }

const codesOf = (input: unknown): string[] => {
  const v = validateProjectRecipeSettings(recipe(), input)
  return v.ok ? [] : v.errors.map((e) => e.code)
}

describe('validateProjectRecipeSettings', () => {
  it('accepts empty settings', () => {
    expect(validateProjectRecipeSettings(recipe(), empty)).toEqual({ ok: true, settings: empty })
  })

  it('accepts defaults of the right type for each parameter', () => {
    const v = validateProjectRecipeSettings(recipe(), {
      ...empty,
      parameterDefaults: {
        period: { from: '2026-10-01', to: '2026-10-31' },
        request_number: 3,
        note: '  Grazie  ',
        sprint: 'current',
      },
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.settings.parameterDefaults.note).toBe('Grazie')
  })

  it('refuses a default for a parameter the recipe does not have', () => {
    expect(codesOf({ ...empty, parameterDefaults: { budget: 3 } })).toEqual([
      'default_parameter_unknown',
    ])
  })

  it('refuses a default of the wrong type or out of range', () => {
    expect(codesOf({ ...empty, parameterDefaults: { request_number: 0 } })).toEqual([
      'default_invalid',
    ])
    expect(codesOf({ ...empty, parameterDefaults: { request_number: 1.5 } })).toEqual([
      'default_invalid',
    ])
    expect(codesOf({ ...empty, parameterDefaults: { sprint: 'next' } })).toEqual([
      'default_invalid',
    ])
    expect(codesOf({ ...empty, parameterDefaults: { note: 'x'.repeat(501) } })).toEqual([
      'default_invalid',
    ])
    expect(
      codesOf({
        ...empty,
        parameterDefaults: { period: { from: '2026-10-31', to: '2026-10-01' } },
      }),
    ).toEqual(['default_invalid'])
    expect(codesOf({ ...empty, parameterDefaults: { period: '2026-10' } })).toEqual([
      'default_invalid',
    ])
  })

  it('refuses a default for a selection of evidence or work items', () => {
    const raw = sampleRecipe()
    raw.parameters.push({
      id: 'minutes',
      type: 'evidence_selection',
      label: 'Verbali',
      required: false,
      step: 3,
      multiple: true,
    })
    const v = validateRecipe(raw)
    if (!v.ok) throw new Error(JSON.stringify(v.errors))
    const s = validateProjectRecipeSettings(v.recipe, {
      ...empty,
      parameterDefaults: { minutes: ['x'] },
    })
    expect(s.ok ? [] : s.errors.map((e) => e.code)).toEqual(['default_not_allowed'])
  })

  it('validates the mapping and the template with the rules of the recipe', () => {
    expect(
      codesOf({
        ...empty,
        mapping: { sections: [{ section: 'nowhere', sheet: 'Uno' }], namedCells: [] },
      }),
    ).toEqual(['render_section_unknown'])
    expect(
      codesOf({
        ...empty,
        mapping: { sections: [], namedCells: [{ name: 'Totale', block: 'summary_text' }] },
      }),
    ).toEqual(['render_cell_invalid'])
    expect(
      codesOf({
        ...empty,
        mapping: { sections: [{ section: 'order', style: 'Titolo 1' }], namedCells: [] },
      }),
    ).toEqual(['render_mapping_wrong_format'])
    expect(codesOf({ ...empty, templateRef: 'Carta intestata' })).toEqual(['settings_malformed'])
  })

  it('refuses a template for a recipe that renders only text', () => {
    const raw = sampleRecipe()
    raw.render = { formats: ['md'], template: null, sections: [], namedCells: [] }
    const v = validateRecipe(raw)
    if (!v.ok) throw new Error(JSON.stringify(v.errors))
    const s = validateProjectRecipeSettings(v.recipe, { ...empty, templateRef: 'carta-intestata' })
    expect(s.ok ? [] : s.errors.map((e) => e.code)).toEqual(['render_template_without_binary'])
  })

  it('accepts labels and bounds them', () => {
    expect(
      validateProjectRecipeSettings(recipe(), {
        ...empty,
        labels: { 'feature:4711': 'Modulo di fatturazione' },
      }).ok,
    ).toBe(true)
    expect(codesOf({ ...empty, labels: { 'feature:1': '' } })).toEqual(['settings_malformed'])
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 'Etichetta']))
    expect(codesOf({ ...empty, labels: many })).toEqual(['labels_too_many'])
  })

  it('refuses a setting it does not know', () => {
    expect(codesOf({ ...empty, gates: { off: true } })).toEqual(['settings_malformed'])
    expect(codesOf(null)).toEqual(['settings_malformed'])
  })

  it('has a text for the PM for every error', () => {
    const v = validateProjectRecipeSettings(recipe(), {
      ...empty,
      parameterDefaults: { budget: 3, request_number: 0 },
      mapping: { sections: [{ section: 'nowhere', sheet: 'Uno' }], namedCells: [] },
    })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      for (const e of v.errors) {
        const text = settingsErrorText(e, 'it')
        expect(text).not.toBe('')
        expect(text).not.toMatch(/request_number|budget/)
      }
    }
  })
})

describe('effectiveProjectRecipe', () => {
  it('applies the template and the mapping of the project to the render of the recipe', () => {
    const effective = effectiveProjectRecipe(recipe(), {
      ...empty,
      templateRef: 'carta-intestata',
      mapping: { sections: [{ section: 'order', sheet: 'Ordine' }], namedCells: [] },
    })
    expect(effective.render.template).toBe('carta-intestata')
    expect(effective.render.sections).toEqual([{ section: 'order', sheet: 'Ordine' }])
    expect(effective.render.namedCells).toEqual([])
  })

  it('keeps the render of the recipe when the project sets nothing', () => {
    const r = recipe()
    expect(effectiveProjectRecipe(r, empty).render).toEqual(r.render)
  })
})
