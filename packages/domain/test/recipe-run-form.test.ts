import { describe, expect, it } from 'vitest'
import { MAX_PARAMETERS_PER_STEP, parameterSteps, skipEffect } from '../src/recipe/index.ts'
import { productRecipe } from './support/product-recipes.ts'

const sprint = productRecipe('deliverable-sprint.json')
const minutes = productRecipe('minutes-from-transcript.json')
const sal = productRecipe('sal-economico.json')

describe('the parameters asked at the start of a run', () => {
  it('asks them step by step, in the order of the steps, never more than five at a time', () => {
    const steps = parameterSteps(sprint)
    expect(steps.map((s) => s.map((p) => p.id))).toEqual([
      ['period', 'sprint', 'closed_states', 'counted_types'],
      ['bug_type', 'cr_type', 'excluded_items', 'attributions'],
    ])
    for (const r of [sprint, minutes, sal]) {
      for (const step of parameterSteps(r)) {
        expect(step.length).toBeLessThanOrEqual(MAX_PARAMETERS_PER_STEP)
      }
    }
  })
})

describe('what skipping a parameter does', () => {
  it('makes the sections that read a mandatory parameter «non dedotto», named as the PM reads them', () => {
    const effect = skipEffect(sprint, 'period')
    expect(effect.kind).toBe('not_deduced')
    if (effect.kind !== 'not_deduced') return
    expect(effect.sections.length).toBeGreaterThan(0)
    expect(effect.sections.join(' ')).not.toMatch(/\{\{/)
  })

  it('reads without the filter when an optional filter is skipped', () => {
    expect(skipEffect(sprint, 'excluded_items')).toEqual({ kind: 'filter_dropped' })
  })

  it('leaves the deliverable internal only when the choice of the client version is skipped', () => {
    expect(skipEffect(minutes, 'for_client')).toEqual({ kind: 'internal_only' })
  })

  it('says which tables need the documents a table is copied from', () => {
    const tables = sal.parameters.filter((p) => p.type === 'rows' && p.evidence === 'invoice_docs')
    expect(tables.length).toBeGreaterThan(0)
    expect(skipEffect(sal, 'invoice_docs')).toEqual({
      kind: 'rows_need_documents',
      tables: tables.map((t) => t.label),
    })
  })

  it('changes nothing for a parameter the recipe does not have', () => {
    expect(skipEffect(sprint, 'unknown')).toEqual({ kind: 'none' })
  })
})
