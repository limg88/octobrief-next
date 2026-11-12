import { describe, expect, it } from 'vitest'
import {
  applyRecipePatch,
  buildSkeleton,
  type DocumentSourceRef,
  type InternalDocument,
  isAcceptableCode,
  mergeDocument,
  type Recipe,
  type RedTeamAnomaly,
  redTeamFindingText,
  type SlotSegment,
} from '../src/recipe/index.ts'
import { audienceContext, recipeOf } from './support/client-version.ts'
import {
  audienceOf,
  deliveryRecipe,
  draftOf,
  EVIDENCE,
  gatherDelivery,
  project,
  salParams,
} from './support/delivery-recipes.ts'
import { itemRef, sampleGathered, TRACKER_AS_OF } from './support/gathered.ts'
import { cleanDraft, redTeam, redTeamContext, segment, summaryText } from './support/red-team.ts'

// What a text of the writer may lean on: never a row the PM excluded, never the passage of a
// document where the detector found an instruction. Both are anomalies of data at the text that
// cites them, which the PM may accept one at a time with a reason; the code never rewrites them.

const only = (as: readonly RedTeamAnomaly[], code: string) => as.filter((a) => a.code === code)

/** The sample recipe with the feature F-15 excluded by the PM. */
function excludingF15(): Recipe {
  const r = applyRecipePatch(
    recipeOf(),
    { operations: [{ op: 'add_exclusion', block: 'features', field: 'id', values: ['F-15'] }] },
    'it',
  )
  if (!r.ok) throw new Error('the exclusion was refused')
  return r.recipe
}

const said = (text: string, ref: DocumentSourceRef): SlotSegment => ({
  text,
  nature: 'fact',
  category: 'other',
  sources: [{ ref, label: 'Elemento del tracker', dataAsOf: TRACKER_AS_OF, category: 'other' }],
})

/** A draft of the recipe whose summary says these segments. */
function draftSaying(recipe: Recipe, segments: SlotSegment[]): InternalDocument {
  const g = sampleGathered()
  g.recipe.version = recipe.version
  const { skeleton } = buildSkeleton(recipe, g)
  return mergeDocument(skeleton, { summary_text: { segments } }) as InternalDocument
}

const contextFor = (recipe: Recipe) =>
  redTeamContext({ recipe, client: { audience: audienceContext(recipe) } })

describe('a text that cites a row the PM excluded', () => {
  it('is an anomaly of data at that text', () => {
    const recipe = excludingF15()
    const doc = draftSaying(recipe, [said('Resta aperta anche F-15.', itemRef('F-15'))])
    const [a, ...more] = only(redTeam(doc, contextFor(recipe)).anomalies, 'excluded_row_cited')
    expect(more).toEqual([])
    expect(a).toMatchObject({ gate: 1, class: 'data', resolution: 'acceptance', status: 'open' })
    expect(a?.ref).toMatchObject({ element: 'segment', block: 'summary_text' })
    expect(isAcceptableCode('excluded_row_cited')).toBe(true)
  })

  it('is no anomaly for a row the PM kept', () => {
    const recipe = excludingF15()
    const doc = draftSaying(recipe, [said('È chiusa F-12.', itemRef('F-12'))])
    expect(only(redTeam(doc, contextFor(recipe)).anomalies, 'excluded_row_cited')).toEqual([])
  })

  it('is told to the PM in words, without codes', () => {
    const recipe = excludingF15()
    const doc = draftSaying(recipe, [said('Resta aperta anche F-15.', itemRef('F-15'))])
    const [a] = only(redTeam(doc, contextFor(recipe)).anomalies, 'excluded_row_cited')
    const text = redTeamFindingText(a as RedTeamAnomaly, 'it')
    expect(text).not.toMatch(/[a-z]+_[a-z_]+/)
    expect(text).toMatch(/escluso|esclusa|esclus/)
  })
})

describe('a text that cites a table of the PM some rows of which are excluded', () => {
  /** The SAL with the third position of the order excluded by the PM. */
  function salExcludingPosition3(): Recipe {
    const r = applyRecipePatch(
      deliveryRecipe('sal-economico'),
      {
        operations: [{ op: 'add_exclusion', block: 'positions', field: 'position', values: ['3'] }],
      },
      'it',
    )
    if (!r.ok) throw new Error(`the exclusion was refused: ${JSON.stringify(r.refusals)}`)
    return r.recipe
  }

  it('is no anomaly: the table as a whole stands for the rows the PM kept too', () => {
    const recipe = salExcludingPosition3()
    const p = project()
    const g = gatherDelivery(recipe, p, salParams(p))
    const whole: DocumentSourceRef = {
      kind: 'parameter',
      parameterId: 'positions',
      evidenceIds: [EVIDENCE.order],
    }
    const { draft } = draftOf(recipe, g, {
      mail_text: { segments: [said('Le posizioni dell’ordine sono quelle indicate.', whole)] },
    })
    // The excluded row is listed apart, citing the same table of the PM.
    const listed = draft.sections
      .flatMap((s) => s.blocks)
      .some((b) => b.kind === 'list' && b.items.length > 0)
    expect(listed).toBe(true)
    const r = redTeam(
      draft,
      redTeamContext({
        recipe,
        client: { audience: audienceOf(recipe, g) },
        parameters: g.parameterTexts,
        periods: g.periods,
        freshness: g.context.freshness,
      }),
    )
    expect(only(r.anomalies, 'excluded_row_cited')).toEqual([])
  })
})

describe('a text that cites the passage holding a suspicious instruction', () => {
  // Note 3 of the sample draft cites page 1 of the warehouse extraction `ev-dwsi`.
  const flagged = (page: number) => ({
    'ev-dwsi': [
      { pattern: 'ignore_rules' as const, chunkIndex: 0, locator: { kind: 'page' as const, page } },
    ],
  })

  function citingNote3(): InternalDocument {
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Lo dice il documento del sistema.', [3]))
    return doc
  }

  it('is an anomaly of data at that text, besides the warning on the document', () => {
    const r = redTeam(citingNote3(), redTeamContext({ suspicious: flagged(1) }))
    const [a, ...more] = only(r.anomalies, 'suspicious_passage_cited')
    expect(more).toEqual([])
    expect(a).toMatchObject({ gate: 1, class: 'data', resolution: 'acceptance', status: 'open' })
    expect(a?.ref).toMatchObject({ element: 'segment', block: 'summary_text' })
    expect(r.warnings.some((w) => w.code === 'suspicious_instruction')).toBe(true)
    // Acceptable one at a time like any data anomaly: it is no credential nor secret.
    expect(isAcceptableCode('suspicious_passage_cited')).toBe(true)
    expect(redTeamFindingText(a as RedTeamAnomaly, 'it')).not.toMatch(/[a-z]+_[a-z_]+/)
  })

  it('is no anomaly when the text cites another passage of the same document', () => {
    const r = redTeam(citingNote3(), redTeamContext({ suspicious: flagged(2) }))
    expect(only(r.anomalies, 'suspicious_passage_cited')).toEqual([])
  })

  it('is no anomaly when nothing in the document was flagged', () => {
    const r = redTeam(citingNote3(), redTeamContext())
    expect(only(r.anomalies, 'suspicious_passage_cited')).toEqual([])
  })
})
