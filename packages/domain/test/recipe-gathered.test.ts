import { describe, expect, it } from 'vitest'
import {
  blockParameters,
  blockRemarkText,
  checkParameterValues,
  DomainError,
  formatDay,
  formatNumber,
  formatPercent,
  MAX_SELECTED,
  notDeducedSections,
  parameterTitleTexts,
  periodsOf,
  periodText,
  sectionParameters,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'

const recipe = recipeOf()

describe('values of the parameters', () => {
  it('keeps the values that fit the recipe', () => {
    const values = checkParameterValues(recipe, {
      period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
      request_number: { type: 'number', value: 3 },
      note: { type: 'text', value: 'Consegna puntuale' },
      sprint: { type: 'choice', value: 'current' },
    })
    expect(Object.keys(values).sort()).toEqual(['note', 'period', 'request_number', 'sprint'])
  })

  it('stops on a value that does not fit, naming the parameter for the PM', () => {
    const bad = [
      { request_number: { type: 'number', value: 2.5 } },
      { request_number: { type: 'number', value: 0 } },
      { request_number: { type: 'text', value: '3' } },
      { period: { type: 'period', from: '2026-10-31', to: '2026-10-01' } },
      { period: { type: 'period', from: '2026-02-30', to: '2026-03-01' } },
      { sprint: { type: 'choice', value: 'next' } },
      { note: { type: 'text', value: 'x'.repeat(501) } },
      { note: { type: 'text', value: '   ' } },
    ] as const
    for (const values of bad) {
      try {
        checkParameterValues(recipe, values as never)
        throw new Error('accepted')
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError)
        expect((e as DomainError).code).toBe('recipe_parameter_invalid')
        expect(String((e as DomainError).params?.name)).not.toBe('')
      }
    }
    expect(() =>
      checkParameterValues(recipe, { unknown: { type: 'number', value: 1 } } as never),
    ).toThrow(DomainError)
  })

  it('admits at most two hundred items selected for one parameter', () => {
    const raw = sampleRecipe()
    raw.parameters.push({
      id: 'docs',
      type: 'evidence_selection',
      label: 'Documenti',
      required: false,
      step: 3,
      multiple: true,
    })
    const withDocs = recipeOf(raw)
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ev-${i}`)
    expect(
      checkParameterValues(withDocs, {
        docs: { type: 'evidence_selection', evidenceIds: ids(MAX_SELECTED) },
      }).docs,
    ).toBeDefined()
    expect(() =>
      checkParameterValues(withDocs, {
        docs: { type: 'evidence_selection', evidenceIds: ids(MAX_SELECTED + 1) },
      }),
    ).toThrow(DomainError)
  })

  it('tells the PM how a block was read, never with a datum', () => {
    expect(blockRemarkText({ code: 'filter_dropped', parameter: 'Sprint' }, 'it')).toBe(
      'Senza filtro su «Sprint»: il dato non è stato indicato.',
    )
    expect(blockRemarkText({ code: 'selection_dropped', count: 2 }, 'it')).toContain(': 2.')
    expect(blockRemarkText({ code: 'source_not_synced', source: 'Jira' }, 'it')).toMatch(/^Jira /)
  })

  it('shows a period, a choice and a number in a title, never a free text', () => {
    const texts = parameterTitleTexts(
      recipe,
      {
        period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
        request_number: { type: 'number', value: 1234 },
        note: { type: 'text', value: 'Nota libera' },
        sprint: { type: 'choice', value: 'previous' },
      },
      'it',
    )
    expect(texts).toEqual({
      period: 'ottobre 2026',
      request_number: '1.234',
      sprint: 'Sprint precedente',
    })
    expect(periodText('2026-10-01', '2026-10-15', 'it')).toBe('dal 01/10/2026 al 15/10/2026')
    expect(periodText('2026-02-01', '2026-02-28', 'it')).toBe('febbraio 2026')
    expect(periodsOf({ period: { type: 'period', from: '2026-10-01', to: '2026-10-31' } })).toEqual(
      { period: { from: '2026-10-01', to: '2026-10-31' } },
    )
  })

  it('finds the parameters each section reads, in titles, queries and values', () => {
    const [order, summary, progress, team] = recipe.sections
    expect([...sectionParameters(order as never)]).toEqual([])
    expect([...sectionParameters(summary as never)]).toEqual(['period'])
    expect([...sectionParameters(progress as never)].sort()).toEqual(['period', 'sprint'])
    expect([...sectionParameters(team as never)]).toEqual([])
    expect([...blockParameters({ kind: 'static', id: 'x', text: 'Testo' })]).toEqual([])
  })

  it('leaves not deduced only the sections that read a skipped mandatory parameter', () => {
    expect([...notDeducedSections(recipe, {})].sort()).toEqual(['progress', 'summary'])
    // An optional parameter skipped narrows nothing and leaves nothing out.
    expect([
      ...notDeducedSections(recipe, {
        period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
        request_number: { type: 'number', value: 1 },
      }),
    ]).toEqual([])
  })
})

describe('numbers and days of a document', () => {
  it('writes them in the Italian way', () => {
    expect(formatNumber(1234.5, 'other', 'it')).toBe('1.234,5')
    expect(formatNumber(8000, 'invoiced_amounts', 'it')).toBe('8.000,00')
    expect(formatNumber(-3, 'costs', 'it')).toBe('-3,00')
    expect(formatPercent(0.4237, 'it')).toBe('42,4%')
    expect(formatDay('2026-10-01')).toBe('01/10/2026')
  })
})
