import { describe, expect, it } from 'vitest'
import { generateDeliveryRecipeProject } from '../../../tools/synthetic/src/recipe-data.ts'
import {
  type GatheredData,
  gateContextOf,
  hasClientVersion,
  type InternalDocument,
  MINUTES_PARTICIPANTS_SLOT,
  minutesParticipants,
  type Recipe,
  recipeText,
  runFileAudiences,
  runRecipeChecks,
  runRedTeam,
  runRedTeamContext,
  type SlotContent,
  type SlotSegment,
} from '../src/recipe/index.ts'
import {
  checksContext,
  draftOf,
  evidenceRef,
  gatheredFor,
  NOW,
  productRecipe,
  said,
  source,
} from './support/product-recipes.ts'
import { verifiedSlots } from './support/red-team.ts'

// The minutes from a transcript on the synthetic delivery project: the transcript chosen by the
// PM, every decision with its place in the transcript, owners and deadlines only when the
// transcript declares them, the participants outside the team reported by the code.

const project = generateDeliveryRecipeProject({ seed: 5 })
const TRANSCRIPT_FILE = project.documents.find((d) => d.fileName.endsWith('.vtt'))?.fileName
if (TRANSCRIPT_FILE === undefined) throw new Error('the synthetic project has no transcript')
const TRANSCRIPT_TITLE: string = TRANSCRIPT_FILE
const TRANSCRIPT_ID = 'ev-transcript'
const truth = project.truth

/** The cue of the transcript a locator of the truth names: «3 (00:00:21)» is cue 3. */
const cueOf = (locator: string): number => Number.parseInt(locator, 10)

/** A source in the transcript: its header is paragraph 1, cue n is paragraph 1 + n. */
const inTranscript = (paragraph: number) =>
  source(evidenceRef(TRANSCRIPT_ID, paragraph), TRANSCRIPT_TITLE)
const HEADER = 1
/** Cue n of the transcript, after its header. */
const cue = (locator: string) => inTranscript(HEADER + cueOf(locator))

function gathered(recipe: Recipe, forClient: 'no' | 'yes' | null = 'no'): GatheredData {
  const header = evidenceRef(TRANSCRIPT_ID, HEADER)
  return gatheredFor(
    recipe,
    {
      transcript: { type: 'evidence_selection', evidenceIds: [TRANSCRIPT_ID] },
      ...(forClient === null ? {} : { for_client: { type: 'choice', value: forClient } }),
    },
    {
      transcript_document: {
        status: 'read',
        rows: [{ values: { date: { day: truth.meeting.date } }, refs: { date: header } }],
        totals: [],
      },
      previous_minutes_document: { status: 'not_deduced', reason: 'parameter_skipped' },
    },
    [{ ref: header, label: TRANSCRIPT_TITLE, dataAsOf: NOW }],
  )
}

const OWNED_ACTION = `Preparare il piano di test; Responsabile: ${truth.actionWithOwner.owner}; Scadenza: 20 novembre 2026`
const UNOWNED_ACTION =
  'Aggiornare il registro dei rischi; Responsabile: da assegnare; Scadenza: da concordare'

/** What a scripted model writes from the transcript, citing its cues. */
function slots(over: Record<string, SlotSegment[]> = {}): Record<string, SlotContent> {
  const base: Record<string, SlotSegment[]> = {
    meeting_time: [
      said(`Riunione del ${truth.meeting.date} alle ${truth.meeting.time}.`, [
        inTranscript(HEADER),
      ]),
    ],
    [MINUTES_PARTICIPANTS_SLOT]: truth.meeting.participants.map((p) =>
      said(p, [inTranscript(HEADER)]),
    ),
    decisions_list: [
      said('Il modulo di reportistica sarà consegnato il 4 dicembre 2026.', [
        cue(truth.decision.locator),
      ]),
    ],
    action_items: [
      said(OWNED_ACTION, [cue(truth.actionWithOwner.locator)]),
      said(UNOWNED_ACTION, [cue(truth.actionWithoutOwner.locator)]),
    ],
    ...over,
  }
  return Object.fromEntries(Object.entries(base).map(([k, segments]) => [k, { segments }]))
}

function draft(
  recipe: Recipe,
  over: Record<string, SlotSegment[]> = {},
  forClient: 'no' | 'yes' | null = 'no',
) {
  const g = gathered(recipe, forClient)
  return { gathered: g, doc: draftOf(recipe, g, slots(over)) }
}

/** The red-team context a run of the minutes judges its drafts with. */
function runContext(recipe: Recipe, g: GatheredData, doc: InternalDocument) {
  return runRedTeamContext({
    recipe,
    gate: gateContextOf(g),
    knownNames: [],
    cited: {
      evidence: {
        [TRANSCRIPT_ID]: {
          audience: {
            kind: 'transcript',
            audience: 'client',
            fromSystem: false,
            title: TRANSCRIPT_TITLE,
          },
          policy: 'document',
          sourceKind: 'manual_upload',
        },
      },
      facts: {},
    },
    suspicious: {},
    declaredValues: [],
    verifications: verifiedSlots(doc),
    acceptances: [],
    decisions: [],
  })
}

const failedChecks = (recipe: Recipe, g: GatheredData, doc: InternalDocument) =>
  runRecipeChecks(doc, checksContext(recipe, g)).anomalies.map((a) => [
    a.ref.element === 'check' ? a.ref.check : null,
    a.code,
    a.class,
  ])

function textOf(doc: InternalDocument, id: string) {
  for (const s of doc.sections) {
    for (const b of s.blocks) if (b.kind === 'text' && b.id === id) return b
  }
  throw new Error(`no text ${id}`)
}

describe('the minutes from a transcript', () => {
  it('the minutes give every decision a transcript locator', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const { gathered: g, doc } = draft(recipe)
    // Every section of the minutes, in its order, from the transcript the PM chose.
    expect(doc.sections.map((s) => s.title)).toEqual([
      'Data, ora e partecipanti',
      'Oggetto e riassunto',
      'Decisioni prese',
      'Discusso e rinviato',
      'Action item',
      'Questioni aperte e riaperte',
      'Rischi',
      'Prossimi passi',
      'Note interne',
    ])
    const decision = textOf(doc, 'decisions_list').segments[0]
    const note = doc.sourceNotes.find((n) => n.n === decision?.sources[0])
    expect(note?.ref).toEqual(evidenceRef(TRANSCRIPT_ID, HEADER + cueOf(truth.decision.locator)))
    expect(failedChecks(recipe, g, doc)).toEqual([])

    // A decision that cites nothing, or only what the PM typed, has no place in the transcript.
    const typed = source({ kind: 'parameter', parameterId: 'for_client' }, 'Indicato da te')
    for (const sources of [[], [typed]]) {
      const bad = draft(recipe, {
        decisions_list: [said('Il perimetro comprende la sede centrale.', sources)],
      })
      expect(failedChecks(recipe, bad.gathered, bad.doc)).toEqual([
        ['decisions_located', 'recipe_check_failed', 'data'],
      ])
    }
  })

  it('a decision citing only the previous minutes has no transcript locator', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const previous = source(evidenceRef('ev-previous-minutes', 2), 'Verbale precedente')
    const bad = draft(recipe, {
      decisions_list: [said('Il perimetro comprende la sede centrale.', [previous])],
      action_items: [said(OWNED_ACTION, [previous])],
    })
    expect(failedChecks(recipe, bad.gathered, bad.doc)).toEqual([
      ['decisions_located', 'recipe_check_failed', 'data'],
      ['actions_assigned', 'recipe_check_failed', 'data'],
    ])
  })

  it('a repeated owner field never hides an undeclared owner', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const hidden = `Aggiornare il registro dei rischi; Responsabile: da assegnare; Responsabile: ${truth.actionWithOwner.owner}; Scadenza: da concordare`
    for (const sources of [[], [cue(truth.actionWithoutOwner.locator)]]) {
      const bad = draft(recipe, { action_items: [said(hidden, sources)] })
      expect(failedChecks(recipe, bad.gathered, bad.doc)).toEqual([
        ['actions_assigned', 'recipe_check_failed', 'data'],
      ])
    }
  })

  it('the minutes stay internal when the PM does not say they go to the client', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    for (const forClient of [null, 'no'] as const) {
      const { gathered: g, doc } = draft(recipe, {}, forClient)
      expect(hasClientVersion(recipe, g.parameters)).toBe(false)
      const gate = gateContextOf(g)
      expect(runFileAudiences(recipe, gate)).toEqual(['internal'])
      const ctx = runContext(recipe, g, doc)
      // No client version is projected, and the red-team runs without it.
      expect(ctx.client).toBeUndefined()
      expect(() => runRedTeam(doc, ctx)).not.toThrow()
    }
    // A run stored before the condition existed, without its parameters: internal only.
    const { gathered: g } = draft(recipe, {}, 'yes')
    const { parameters: _parameters, ...old } = gateContextOf(g)
    expect(runFileAudiences(recipe, old)).toEqual(['internal'])
  })

  it('the minutes have a client version when the PM says they go to the client', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const { gathered: g, doc } = draft(recipe, {}, 'yes')
    expect(hasClientVersion(recipe, g.parameters)).toBe(true)
    expect(runFileAudiences(recipe, gateContextOf(g))).toEqual(['internal', 'client'])
    const ctx = runContext(recipe, g, doc)
    expect(ctx.client).toBeDefined()
    const result = runRedTeam(doc, ctx)
    expect(result.gates.find((x) => x.gate === 5)?.checks).toBeGreaterThan(0)
  })

  it('the minutes write “da assegnare” when no owner was declared', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const { gathered: g, doc } = draft(recipe)
    // The action the transcript gives no owner keeps the placeholders; the other its owner.
    const actions = textOf(doc, 'action_items').segments.map((s) => s.text)
    expect(actions).toEqual([OWNED_ACTION, UNOWNED_ACTION])
    expect(failedChecks(recipe, g, doc)).toEqual([])

    const invented = `Aggiornare il registro dei rischi; Responsabile: ${truth.actionWithOwner.owner}; Scadenza: 30 novembre 2026`
    for (const segments of [
      // An owner and a deadline nobody declared, with no place in the transcript.
      [said(invented, [])],
      // An action without owner nor deadline: they are written «da assegnare», «da concordare».
      [said('Aggiornare il registro dei rischi', [cue(truth.actionWithoutOwner.locator)])],
    ]) {
      const bad = draft(recipe, { action_items: segments })
      expect(failedChecks(recipe, bad.gathered, bad.doc)).toEqual([
        ['actions_assigned', 'recipe_check_failed', 'data'],
      ])
    }
  })

  it('the minutes flag an external participant without guessing the organization', () => {
    const recipe = productRecipe('minutes-from-transcript.json')
    const { doc } = draft(recipe)
    const team = project.team.map((m) => ({ displayName: m.name }))
    const result = minutesParticipants(doc, team, 'it')
    const expected = truth.meeting.participants.filter(
      (p) => !project.team.some((m) => m.name === p),
    )
    expect(expected).toContain(truth.externalParticipant)
    expect(result.participants).toEqual(truth.meeting.participants)
    expect(result.outsideTeam).toEqual(expected)
    // The note names them and says the organization is not deduced: nothing more.
    expect(result.internalNotes).toEqual([
      recipeText('minutes', 'participants_outside_team', { names: expected.join(', ') }, 'it'),
    ])
    expect(result.internalNotes[0]).toContain('non è dedotta')
    // A participant of the team, written with other case and spaces, is still of the team.
    const member = project.team[0]?.name ?? ''
    const shouted = draft(recipe, {
      [MINUTES_PARTICIPANTS_SLOT]: [said(`  ${member.toUpperCase()}.`, [inTranscript(HEADER)])],
    })
    expect(minutesParticipants(shouted.doc, team, 'it')).toEqual({
      participants: [member.toUpperCase()],
      outsideTeam: [],
      internalNotes: [],
    })
  })
})
