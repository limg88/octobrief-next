import { describe, expect, it } from 'vitest'
import { redTeamFindingText, reviewerSampleWarnings, SLOT_LIMITS } from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { cleanDraft, redTeamContext } from './support/red-team.ts'

/** The draft with its first table made `rows` rows long. */
function draftWithRows(rows: number) {
  const doc = cleanDraft()
  const table = doc.sections
    .flatMap((s) => s.blocks)
    .find((b): b is Extract<typeof b, { kind: 'table' }> => b.kind === 'table')
  const first = table?.rows[0]
  if (!table || !first) throw new Error('no table')
  table.rows = Array.from({ length: rows }, (_, i) => ({ ...first, key: `k${i}` }))
  return { doc, title: table.title }
}

describe('the review of a long draft', () => {
  const withRules = () =>
    redTeamContext({
      recipe: { ...recipeOf(), redTeamRules: ['Nessun testo contraddice le tabelle.'] },
    })

  it('the reviewer says when it checked a sample of the rows', () => {
    const { doc, title } = draftWithRows(SLOT_LIMITS.rowsReviewed + 50)
    const warnings = reviewerSampleWarnings(doc, withRules())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      code: 'reviewer_sample',
      requiresConfirmation: false,
      detail: { rows: SLOT_LIMITS.rowsReviewed, of: SLOT_LIMITS.rowsReviewed + 50 },
    })
    const text = redTeamFindingText(warnings[0] as (typeof warnings)[number], 'it')
    expect(text).toContain(`un campione di ${SLOT_LIMITS.rowsReviewed} righe`)
    expect(text).toContain(String(title))
  })

  it('says nothing when every row was read, or when no reviewer ran', () => {
    expect(
      reviewerSampleWarnings(draftWithRows(SLOT_LIMITS.rowsReviewed).doc, withRules()),
    ).toEqual([])
    const long = draftWithRows(SLOT_LIMITS.rowsReviewed + 1).doc
    expect(
      reviewerSampleWarnings(long, redTeamContext({ recipe: { ...recipeOf(), redTeamRules: [] } })),
    ).toEqual([])
  })
})
