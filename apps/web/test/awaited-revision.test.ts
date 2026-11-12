import { describe, expect, it } from 'vitest'
import { type AwaitedRevision, awaitsRevision } from '../src/lib/queries.ts'

const awaited: AwaitedRevision = { revision: 1, revisionError: null, until: 1_000 }
const view = (revision: number, revisionError: string | null = null) => ({
  revision,
  run: { revisionError },
})

describe('awaitsRevision', () => {
  it('waits while the page still shows what it showed when the change was asked', () => {
    expect(awaitsRevision(view(1), awaited, 500)).toBe(true)
  })

  it('stops when the new revision arrives', () => {
    expect(awaitsRevision(view(2), awaited, 500)).toBe(false)
  })

  it('stops when the revision is refused', () => {
    expect(awaitsRevision(view(1, 'not_better'), awaited, 500)).toBe(false)
  })

  it('stops after the wait is over, and when no change was asked', () => {
    expect(awaitsRevision(view(1), awaited, 1_000)).toBe(false)
    expect(awaitsRevision(view(1), undefined, 500)).toBe(false)
  })
})
