import { describe, expect, it } from 'vitest'
import { diffRevisions, type InternalDocument } from '../src/recipe/index.ts'
import { cleanDraft, segment, summaryText } from './support/red-team.ts'

// «Mostra differenze»: two revisions aligned by section, block, segment and row.

describe('the differences between two revisions', () => {
  it('finds nothing between a revision and itself', () => {
    const doc = cleanDraft()
    const d = diffRevisions(doc, structuredClone(doc))
    expect(d.changed).toBe(false)
    expect(d.sections.every((s) => s.change === 'unchanged')).toBe(true)
  })

  it('aligns the segments of a text: one new sentence is one addition', () => {
    const before = cleanDraft()
    const after = structuredClone(before)
    const segs = summaryText(after).segments
    segs.splice(1, 0, segment('Il collaudo parte lunedì.'))
    const d = diffRevisions(before, after)
    expect(d.changed).toBe(true)
    const summary = d.sections.find((s) => s.id === 'summary')
    const text = summary?.blocks.find((b) => b.id === 'summary_text')
    expect(summary?.change).toBe('changed')
    expect(text?.segments?.map((s) => s.change)).toEqual([
      ...summaryText(before)
        .segments.slice(0, 1)
        .map(() => 'unchanged'),
      'added',
      ...summaryText(before)
        .segments.slice(1)
        .map(() => 'unchanged'),
    ])
  })

  it('shows a reworded sentence as removed and added, in place', () => {
    const before = cleanDraft()
    const after = structuredClone(before)
    const segs = summaryText(after).segments
    segs[0] = segment('Una sintesi riscritta.')
    const text = diffRevisions(before, after)
      .sections.flatMap((s) => s.blocks)
      .find((b) => b.id === 'summary_text')
    expect(text?.segments?.slice(0, 2).map((s) => s.change)).toEqual(['added', 'removed'])
    expect(text?.segments?.[0]?.after?.text).toBe('Una sintesi riscritta.')
  })

  it('aligns table rows by their key and values by their block', () => {
    const before = cleanDraft()
    const after = structuredClone(before) as InternalDocument
    const order = after.sections.find((s) => s.id === 'order')
    const table = order?.blocks.find((b) => b.kind === 'table')
    if (table?.kind !== 'table') throw new Error('sample draft without a table')
    const first = table.rows[0]
    if (!first) throw new Error('sample table without rows')
    ;(first.cells[0] as { text: string | null }).text = 'cambiato'
    const d = diffRevisions(before, after)
    const rows = d.sections.flatMap((s) => s.blocks).find((b) => b.id === table.id)?.rows
    expect(rows?.find((r) => r.key === first.key)?.change).toBe('changed')
    expect(rows?.filter((r) => r.change === 'unchanged')).toHaveLength(table.rows.length - 1)
  })

  it('marks a section that is only in one revision as added or removed, where it was', () => {
    const before = cleanDraft()
    const after = structuredClone(before)
    const removed = after.sections.splice(0, 1)[0]
    const d = diffRevisions(before, after)
    expect(d.sections[0]).toMatchObject({ id: removed?.id, change: 'removed' })
    expect(diffRevisions(after, before).sections[0]).toMatchObject({
      id: removed?.id,
      change: 'added',
    })
  })
})
