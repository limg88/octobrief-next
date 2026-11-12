import { describe, expect, it } from 'vitest'
import {
  CHECK_CLASS,
  diffRecipes,
  fieldValues,
  type InternalDocument,
  type RecipeChecksContext,
  recipeText,
  runRecipeChecks,
  validateRecipe,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'
import { cleanDraft, segment, summaryText } from './support/red-team.ts'

/** The first value a text states for a field; null when it does not state it, or states it empty. */
const fieldValue = (text: string, label: string, others: readonly string[] = []) =>
  fieldValues(text, label, others)[0] ?? null

// The checks of the catalog on the segments of a text slot: the kinds of place every segment
// cites, and the fields every segment states, with their placeholder when nobody declared them.

const base = { label: 'controllo dei segmenti', message: 'Il testo non torna.' }

const CITED = {
  id: 'cited',
  ...base,
  kind: 'segments_cited',
  slot: 'summary_text',
  sourceKinds: ['system_row'],
}
const FIELDS = {
  id: 'fields',
  ...base,
  kind: 'segment_fields',
  slot: 'summary_text',
  fields: [
    { label: 'Responsabile', placeholder: 'da assegnare' },
    { label: 'Scadenza', placeholder: 'da concordare' },
  ],
  sourceKinds: ['system_row'],
}

function raw(checks: Array<Record<string, unknown>>) {
  const r = sampleRecipe()
  r.checks = checks
  return r
}

const ctx = (checks: Array<Record<string, unknown>>): RecipeChecksContext => ({
  recipe: recipeOf(raw(checks)),
  lang: 'it',
  parameters: { period: 'ottobre 2026', request_number: '3' },
  periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
  declaredValues: [],
})

/** The sample draft whose summary says only these segments. */
function draftSaying(...segments: InternalDocument['internalNotes']): InternalDocument {
  const doc = cleanDraft()
  summaryText(doc).segments = segments
  return doc
}

const outcome = (doc: InternalDocument, check: Record<string, unknown>) =>
  runRecipeChecks(doc, ctx([check])).anomalies.map((a) => [a.code, a.class, a.detail])

describe('checks on the segments of a text', () => {
  it('are anomalies of data, never rewritten automatically', () => {
    expect(CHECK_CLASS.segments_cited).toBe('data')
    expect(CHECK_CLASS.segment_fields).toBe('data')
    const failed = runRecipeChecks(draftSaying(segment('Nessuna fonte.')), ctx([CITED]))
    expect(failed.anomalies[0]?.slot).toBeNull()
  })

  it('find a segment that cites no place of the kinds asked', () => {
    // Note 1 of the sample draft is a row of the warehouse, note 2 a work item.
    expect(outcome(draftSaying(segment('Dalla riga dell’ordine.', [1])), CITED)).toEqual([])
    expect(
      outcome(draftSaying(segment('Dalla riga.', [1]), segment('Dal tracker.', [2])), CITED),
    ).toEqual([
      [
        'recipe_check_failed',
        'data',
        { kind: 'segments_cited', label: base.label, message: base.message, segments: 1 },
      ],
    ])
  })

  it('pass on an empty slot: nothing is said, nothing is uncited', () => {
    expect(outcome(draftSaying(), CITED)).toEqual([])
    expect(outcome(draftSaying(), FIELDS)).toEqual([])
  })

  it('cannot judge a slot the draft does not have', () => {
    const doc = cleanDraft()
    const summary = doc.sections.find((s) => s.id === 'summary')
    if (!summary) throw new Error('no summary')
    summary.blocks = summary.blocks.filter((b) => b.id !== 'summary_text')
    expect(outcome(doc, CITED).map(([code]) => code)).toEqual(['recipe_check_not_evaluable'])
    expect(outcome(doc, FIELDS).map(([code]) => code)).toEqual(['recipe_check_not_evaluable'])
  })

  it('accept a field left to its placeholder, or filled in a segment that cites its place', () => {
    const ok = draftSaying(
      segment('Aggiornare il registro; Responsabile: da assegnare; Scadenza: da concordare'),
      segment('Preparare il piano — Responsabile: Persona Uno — Scadenza: 20/11/2026', [1]),
    )
    expect(outcome(ok, FIELDS)).toEqual([])
  })

  it('find a field missing, and a field filled with no place to cite', () => {
    const doc = draftSaying(
      segment('Aggiornare il registro; Responsabile: da assegnare'),
      segment('Preparare il piano; Responsabile: Persona Uno; Scadenza: da concordare', [2]),
      segment('Chiudere il rilascio; Responsabile: ; Scadenza: da concordare', [1]),
      // A placeholder that still names someone is a value.
      segment(
        'Rifare il test; Responsabile: da assegnare (forse Persona Uno); Scadenza: da concordare.',
      ),
    )
    expect(outcome(doc, FIELDS)).toEqual([
      [
        'recipe_check_failed',
        'data',
        {
          kind: 'segment_fields',
          label: base.label,
          message: base.message,
          missing: 2,
          unsourced: 2,
          repeated: 0,
        },
      ],
    ])
  })

  it('read a field after its label and colon, up to a semicolon or the next field', () => {
    expect(fieldValue('Azione; Responsabile: Persona Uno; Scadenza: domani', 'Responsabile')).toBe(
      'persona uno',
    )
    expect(
      fieldValue('Azione — Responsabile: da assegnare — Scadenza: x', 'Responsabile', ['Scadenza']),
    ).toBe('da assegnare')
    expect(fieldValue('Azione; Responsabile : Persona Uno', 'responsabile')).toBe('persona uno')
    // Not a field: the label inside another word, without a colon, or with nothing after it.
    expect(fieldValue('Corresponsabile: Persona Uno', 'Responsabile')).toBeNull()
    expect(fieldValue('Il responsabile è Persona Uno', 'Responsabile')).toBeNull()
    expect(fieldValue('Responsabile: ; Scadenza: x', 'Responsabile', ['Scadenza'])).toBeNull()
    expect(fieldValue('Responsabile: Scadenza: x', 'Responsabile', ['Scadenza'])).toBeNull()
    expect(fieldValue('Responsabile: x', '')).toBeNull()
  })

  it('validate only on a text slot of the recipe', () => {
    expect(validateRecipe(raw([CITED, FIELDS])).ok).toBe(true)
    const codes = (check: Record<string, unknown>) => {
      const v = validateRecipe(raw([check]))
      return v.ok ? [] : v.errors.map((e) => e.code)
    }
    expect(codes({ ...CITED, slot: 'nowhere' })).toEqual(['check_target_unknown'])
    expect(codes({ ...FIELDS, slot: 'positions' })).toEqual(['check_not_applicable'])
    expect(codes({ ...CITED, sourceKinds: [] })).toEqual(['recipe_malformed'])
    expect(codes({ ...FIELDS, fields: [] })).toEqual(['recipe_malformed'])
    expect(codes({ ...CITED, sourceKinds: ['mail'] })).toEqual(['recipe_malformed'])
    // Narrowed to the evidence of a selection: a parameter of evidence that a block lists.
    expect(codes({ ...CITED, parameter: 'nowhere' })).toEqual(['parameter_unknown'])
    expect(codes({ ...CITED, parameter: 'period' })).toEqual(['parameter_wrong_type'])
    const withSelection = raw([{ ...FIELDS, sourceKinds: ['evidence'], parameter: 'minutes' }])
    withSelection.parameters.push({
      id: 'minutes',
      type: 'evidence_selection',
      label: 'Verbale',
      required: false,
      step: 3,
      multiple: false,
    })
    const unlisted = validateRecipe(withSelection)
    expect(unlisted.ok ? [] : unlisted.errors.map((e) => e.code)).toEqual(['check_not_applicable'])
    withSelection.sections[1]?.blocks.push({
      kind: 'data_list',
      id: 'minutes_doc',
      query: { kind: 'parameter', parameter: 'minutes' },
      columns: [
        { id: 'date', title: 'Data', from: { kind: 'field', field: 'date' }, category: 'other' },
      ],
    })
    expect(validateRecipe(withSelection).ok).toBe(true)
    // Only evidence can be narrowed to a selection.
    const wrongKind = structuredClone(withSelection)
    wrongKind.checks = [{ ...FIELDS, sourceKinds: ['fact'], parameter: 'minutes' }]
    const kinds = validateRecipe(wrongKind)
    expect(kinds.ok ? [] : kinds.errors.map((e) => e.code)).toEqual(['check_not_applicable'])
  })

  it('a repeated owner field never hides an undeclared owner', () => {
    const text =
      'Azione; Responsabile: da assegnare; Responsabile: Persona Uno; Scadenza: da concordare'
    // Uncited: the second owner is a value nobody declared, whatever the first says.
    expect(outcome(draftSaying(segment(text)), FIELDS)).toEqual([
      [
        'recipe_check_failed',
        'data',
        {
          kind: 'segment_fields',
          label: base.label,
          message: base.message,
          missing: 0,
          unsourced: 0,
          repeated: 1,
        },
      ],
    ])
    // Cited, a field stated twice is still an anomaly: which owner holds is not for the code.
    expect(outcome(draftSaying(segment(text, [1])), FIELDS).length).toBe(1)
    // The placeholder holds only as the whole value.
    expect(
      outcome(
        draftSaying(
          segment('Azione; Responsabile: da assegnare Persona Uno; Scadenza: da concordare'),
        ),
        FIELDS,
      ).length,
    ).toBe(1)
  })

  it('have a name for the PM and show their slot in the differences', () => {
    expect(recipeText('checkKinds', 'segments_cited', {}, 'it')).not.toBe('')
    expect(recipeText('checkKinds', 'segment_fields', {}, 'it')).not.toBe('')
    const before = recipeOf(raw([]))
    const after = recipeOf(raw([CITED]))
    expect(diffRecipes(before, after, 'it').map((c) => c.code)).toEqual(['check_added'])
    const moved = sampleRecipe()
    const summary = moved.sections.find((s) => s.id === 'summary')
    summary?.blocks.push({
      kind: 'text_slot',
      id: 'other_text',
      instructions: 'Altro testo.',
      natures: ['fact'],
      maxChars: 200,
    })
    moved.checks = [CITED]
    const widened = structuredClone(moved)
    widened.checks = [{ ...CITED, slot: 'other_text' }]
    expect(diffRecipes(recipeOf(moved), recipeOf(widened), 'it').map((c) => c.code)).toContain(
      'check_scope_changed',
    )
  })
})
