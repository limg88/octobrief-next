import { describe, expect, it } from 'vitest'
import { generateDeliveryRecipeProject } from '../../../tools/synthetic/src/recipe-data.ts'
import {
  availableActions,
  type GatheredData,
  type InternalDocument,
  mailCopy,
  type ParameterValues,
  projectClientVersion,
  type Recipe,
  type RevisionFacts,
  runRecipeChecks,
  type SlotContent,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  checksContext,
  draftOf,
  gatheredFor,
  productRecipe,
  said,
  source,
} from './support/product-recipes.ts'

// The client mail of the library on the synthetic delivery project: one main request typed by the
// PM, with who must answer and by when, never written by the model; the recipients checked by
// the code against the team, in the internal notes only.

const project = generateDeliveryRecipeProject({ seed: 11 })
const REQUEST = 'Confermare la data di consegna del modulo di reportistica'
const OWNER = 'Referente del cliente'

function parameters(over: Partial<Record<string, ParameterValues[string] | null>> = {}) {
  const values: Record<string, ParameterValues[string] | null> = {
    communication_type: { type: 'choice', value: 'decision_request' },
    facts: { type: 'text', value: 'Il modulo di reportistica è in collaudo interno.' },
    request: { type: 'text', value: REQUEST },
    request_owner: { type: 'text', value: OWNER },
    request_due: { type: 'date', day: '2026-11-20' },
    ...over,
  }
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) as ParameterValues
}

/** The text the model writes: everything cites the facts the PM gave. */
function slots(
  nextStep = 'Alla vostra conferma il team pianifica il rilascio.',
): Record<string, SlotContent> {
  const facts = source({ kind: 'parameter', parameterId: 'facts' }, 'Indicato da te: Fatti')
  return {
    subject_line: { segments: [said('Data di consegna del modulo di reportistica', [facts])] },
    context: { segments: [said('Il modulo di reportistica è in collaudo interno.', [facts])] },
    current_state: { segments: [said('Il collaudo interno è in corso.', [facts], 'inference')] },
    next_step: { segments: [said(nextStep, [], 'suggestion')] },
  }
}

function draft(
  recipe: Recipe,
  values = parameters(),
  next?: string,
): { gathered: GatheredData; doc: InternalDocument } {
  const gathered = gatheredFor(recipe, values)
  return { gathered, doc: draftOf(recipe, gathered, slots(next)) }
}

const blocksOf = (doc: InternalDocument) => doc.sections.flatMap((s) => s.blocks)

const failedChecks = (recipe: Recipe, gathered: GatheredData, doc: InternalDocument) =>
  runRecipeChecks(doc, checksContext(recipe, gathered)).anomalies.map((a) => [
    a.ref.element === 'check' ? a.ref.check : null,
    a.code,
    a.class,
  ])

describe('the client mail recipe', () => {
  it('the mail has exactly one main request with an owner and a deadline', () => {
    const recipe = productRecipe('client-mail.json')
    const { gathered, doc } = draft(recipe)
    const body = doc.sections.find((s) => s.id === 'body')
    const values = (body?.blocks ?? []).filter((b) => b.kind === 'value')
    // The request is the PM's: three values of the body, each typed by the PM and cited so.
    expect(values.map((v) => [v.id, v.label, v.cell.text])).toEqual([
      ['request_action', 'Azione richiesta', REQUEST],
      ['request_owner_value', 'Chi deve rispondere', OWNER],
      ['request_due_value', 'Entro il', '20/11/2026'],
    ])
    for (const v of values) {
      const note = doc.sourceNotes.find((n) => n.n === v.cell.sources[0])
      expect(note?.ref.kind).toBe('parameter')
    }
    // Exactly one request in the whole mail, and no slot where the model could write another.
    expect(blocksOf(doc).filter((b) => b.id === 'request_action')).toHaveLength(1)
    const slotIds = recipe.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) => (b.kind === 'text_slot' ? [b.id] : []))
    expect(slotIds.filter((id) => id.includes('request'))).toEqual([])
    expect(failedChecks(recipe, gathered, doc)).toEqual([])

    // A second request written in the text is an anomaly.
    const twice = draft(recipe, parameters(), 'Vi chiediamo anche di inviarci i dati di prova.')
    expect(failedChecks(recipe, twice.gathered, twice.doc)).toEqual([
      ['single_request_next_step', 'recipe_check_failed', 'form'],
    ])

    // Without who must answer or by when the request is not there: never filled by the model.
    for (const skipped of ['request_owner', 'request_due'] as const) {
      const without = draft(recipe, parameters({ [skipped]: null }))
      expect(failedChecks(recipe, without.gathered, without.doc)).toContainEqual([
        `${skipped}_present`,
        'recipe_check_failed',
        'data',
      ])
    }
  })

  it('the mail flags a recipient outside the team in the internal notes', () => {
    const recipe = productRecipe('client-mail.json')
    const outsider = 'referente@cliente.example'
    const member = project.team[0]
    if (!member) throw new Error('the synthetic team is empty')
    const values = parameters({
      recipients: { type: 'text', value: `${member.email}; ${outsider}` },
    })
    const { gathered, doc } = draft(recipe, values)
    const { version } = projectClientVersion(doc, audienceOf(recipe, gathered))
    const facts: RevisionFacts = {
      state: 'approved',
      n: 1,
      blockers: [],
      acceptable: 0,
      decidable: 0,
      confirmable: 0,
      textSlots: 4,
      snapshotTooOld: false,
    }
    const result = mailCopy({
      actions: availableActions(facts, { role: 'pm' }),
      client: version.document,
      internalNotes: doc.internalNotes,
      parameters: gathered.parameters,
      team: project.team.map((m) => ({ displayName: m.name, email: m.email })),
      lang: 'it',
    })
    if (!result.ok) throw new Error(`no copy: ${result.reason}`)
    const mail = result.mail
    expect(mail.recipients).toEqual([member.email, outsider])
    expect(mail.outsideTeam).toEqual([outsider])
    expect(mail.internalNotes.some((n) => n.includes(outsider))).toBe(true)
    // The warning is for the PM: never in what is copied, never in the internal section's text.
    expect(mail.copyText).not.toContain(outsider)
    expect(mail.markdown).not.toContain(outsider)
    expect(mail.copyText).toContain(`Azione richiesta: ${REQUEST}`)
    expect(mail.copyText).toContain(`Chi deve rispondere: ${OWNER}`)
    expect(mail.copyText).toContain('Entro il: 20/11/2026')
    // The internal notes of the recipe stay out of the copy.
    expect(mail.copyText).not.toContain('Fatti indicati dal PM')
  })
})
