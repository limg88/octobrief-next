import { describe, expect, it } from 'vitest'
import { blockRemarkWarnings, redTeamFindingText } from '../src/recipe/index.ts'
import { cleanDraft } from './support/red-team.ts'

describe('how the blocks of a draft were read, told to the PM', () => {
  it('a remark of the gathering is a warning with its place, a skipped filter is not', () => {
    const doc = cleanDraft()
    const table = doc.sections.flatMap((s) => s.blocks).find((b) => b.kind === 'table')
    if (!table) throw new Error('no table')
    const warnings = blockRemarkWarnings(
      doc,
      {
        [table.id]: [
          { code: 'filter_dropped', parameter: 'Iterazione del PI nel tracker' },
          { code: 'internal_source_left_out', source: 'Backlog interno' },
        ],
      },
      'it',
    )
    expect(warnings.map((w) => [w.code, w.requiresConfirmation])).toEqual([['block_remark', false]])
    expect(redTeamFindingText(warnings[0] as (typeof warnings)[number], 'it')).toContain(
      'Backlog interno è una fonte interna',
    )
    // A block the draft does not have says nothing.
    expect(
      blockRemarkWarnings(doc, { other: [{ code: 'sprint_not_found', sprint: 'S9' }] }, 'it'),
    ).toEqual([])
  })
})
