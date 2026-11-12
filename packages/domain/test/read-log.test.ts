import { describe, expect, it } from 'vitest'
import {
  createReadLog,
  type EvidenceId,
  type FactId,
  locatorKey,
  type SourceId,
} from '../src/recipe/index.ts'

const e1 = 'e1' as EvidenceId
const e2 = 'e2' as EvidenceId
const f1 = 'f1' as FactId
const page = (n: number) => ({ kind: 'page', page: n }) as const

describe('read log', () => {
  it('records the locators read of each piece of evidence without duplicates', () => {
    const log = createReadLog()
    log.recordEvidence(e1, [{ locator: page(1), numbers: [] }])
    log.recordEvidence(e1, [
      { locator: page(1), numbers: [] },
      { locator: page(2), numbers: [] },
    ])
    log.recordEvidence(e2, [{ locator: { kind: 'cell', sheet: 'A', ref: 'B2' }, numbers: [] }])
    const entries = log.snapshot().entries
    expect(entries).toHaveLength(2)
    const first = entries[0]
    expect(first && 'evidenceId' in first && first.reads.map((r) => locatorKey(r.locator))).toEqual(
      ['page:1', 'page:2'],
    )
  })

  it('keeps the numbers shown at each locator, merging repeated reads', () => {
    const log = createReadLog()
    log.recordEvidence(e1, [{ locator: page(1), numbers: ['1200', '3'] }])
    log.recordEvidence(e1, [{ locator: page(1), numbers: ['3', '45.5'] }])
    expect(log.snapshot().entries).toEqual([
      { evidenceId: e1, reads: [{ locator: page(1), numbers: ['1200', '3', '45.5'] }] },
    ])
  })

  it('records a fact once, with the numbers of every read', () => {
    const log = createReadLog()
    log.recordFact(f1, ['10'])
    log.recordFact(f1, ['10', '20'])
    expect(log.snapshot().entries).toEqual([{ factId: f1, numbers: ['10', '20'] }])
  })

  it('hands out frozen snapshots that later reads do not change', () => {
    const log = createReadLog()
    log.recordFact(f1, [])
    log.recordEvidence(e2, [{ locator: page(1), numbers: ['1'] }])
    const before = log.snapshot()
    log.recordEvidence(e1, [{ locator: page(1), numbers: [] }])
    log.recordEvidence(e2, [{ locator: page(1), numbers: ['2'] }])
    log.recordFact(f1, ['9'])
    expect(before.entries).toHaveLength(2)
    expect(before.entries).toEqual([
      { factId: f1, numbers: [] },
      { evidenceId: e2, reads: [{ locator: page(1), numbers: ['1'] }] },
    ])
    expect(Object.isFrozen(before)).toBe(true)
    expect(Object.isFrozen(before.entries)).toBe(true)
    expect(log.snapshot().entries).toHaveLength(3)
  })

  it('ignores a read of evidence with no locators', () => {
    const log = createReadLog()
    log.recordEvidence(e1, [])
    expect(log.snapshot().entries).toEqual([])
  })

  it('records the places of a tracker shown, merging the numbers of repeated reads', () => {
    const log = createReadLog()
    const s1 = 's1' as SourceId
    log.recordTracker(s1, [])
    expect(log.snapshot().entries).toEqual([])
    log.recordTracker(s1, [
      { locator: { kind: 'work_item', id: '42' }, numbers: ['42', '5'] },
      { locator: { kind: 'work_item_counts' }, numbers: ['12'] },
    ])
    log.recordTracker(s1, [
      { locator: { kind: 'work_item', id: '42' }, numbers: ['5', '8'] },
      { locator: { kind: 'work_item', id: '42', field: 'state' }, numbers: ['42'] },
    ])
    log.recordFact(f1, [])
    const entries = log.snapshot().entries
    expect(entries).toEqual([
      {
        trackerSourceId: s1,
        reads: [
          { locator: { kind: 'work_item', id: '42' }, numbers: ['42', '5', '8'] },
          { locator: { kind: 'work_item_counts' }, numbers: ['12'] },
          { locator: { kind: 'work_item', id: '42', field: 'state' }, numbers: ['42'] },
        ],
      },
      { factId: f1, numbers: [] },
    ])
    expect(Object.isFrozen(entries[0])).toBe(true)
  })
})
