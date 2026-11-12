import type { DeliverableDocument, DocumentBlock, DocumentSegment } from './document-model.ts'
import { canonicalJson } from './hash.ts'

// «Mostra differenze»: two revisions of a draft aligned by section (by id), by block (by id), by
// segment of a text (the longest common sequence of segments, so one new sentence does not mark
// the whole text as changed) and by row of a table (by its key). Only what the PM reads is
// compared: texts, cells and values with their sources; never fingerprints or places.

export type DiffChange = 'added' | 'removed' | 'changed' | 'unchanged'

export interface SegmentDiff {
  change: 'added' | 'removed' | 'unchanged'
  before: DocumentSegment | null
  after: DocumentSegment | null
}

export interface RowDiff {
  key: string
  change: DiffChange
  /** The texts of the cells; null for a row that is not there. */
  before: Array<string | null> | null
  after: Array<string | null> | null
}

export interface BlockDiff {
  id: string
  kind: DocumentBlock['kind']
  change: DiffChange
  /** For a text block. */
  segments?: SegmentDiff[]
  /** For a table or a list. */
  rows?: RowDiff[]
  /** For a value or a fixed text. */
  value?: { before: string | null; after: string | null }
}

export interface SectionDiff {
  id: string
  title: string
  change: DiffChange
  blocks: BlockDiff[]
}

export interface RevisionDiff {
  /** Whether anything the PM reads changed. */
  changed: boolean
  title: { before: string; after: string; change: 'changed' | 'unchanged' }
  sections: SectionDiff[]
  /** The notes for the PM, aligned like a text. */
  internalNotes: SegmentDiff[]
}

type Section = DeliverableDocument['sections'][number]

const segmentKey = (s: DocumentSegment) =>
  canonicalJson({ text: s.text, nature: s.nature, sources: s.sources })

/** The two lists of segments aligned on their longest common sequence. */
export function alignSegments(
  before: readonly DocumentSegment[],
  after: readonly DocumentSegment[],
): SegmentDiff[] {
  const a = before.map(segmentKey)
  const b = after.map(segmentKey)
  // lcs[i][j]: the longest common sequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number)
    }
  }
  const out: SegmentDiff[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ change: 'unchanged', before: before[i] ?? null, after: after[j] ?? null })
      i++
      j++
    } else if (
      j < b.length &&
      (i >= a.length ||
        ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    ) {
      out.push({ change: 'added', before: null, after: after[j] ?? null })
      j++
    } else {
      out.push({ change: 'removed', before: before[i] ?? null, after: null })
      i++
    }
  }
  return out
}

const cellTexts = (cells: ReadonlyArray<{ text: string | null }>) => cells.map((c) => c.text)

function rowsOf(block: DocumentBlock) {
  return block.kind === 'table' ? block.rows : block.kind === 'list' ? block.items : []
}

function diffRows(before: DocumentBlock | undefined, after: DocumentBlock | undefined): RowDiff[] {
  const a = before ? rowsOf(before) : []
  const b = after ? rowsOf(after) : []
  const inBefore = new Map(a.map((r) => [r.key, r]))
  const inAfter = new Set(b.map((r) => r.key))
  const out: RowDiff[] = b.map((r) => {
    const old = inBefore.get(r.key)
    const now = cellTexts(r.cells)
    if (old === undefined) return { key: r.key, change: 'added', before: null, after: now }
    const was = cellTexts(old.cells)
    const same = canonicalJson(old.cells) === canonicalJson(r.cells)
    return { key: r.key, change: same ? 'unchanged' : 'changed', before: was, after: now }
  })
  for (const r of a) {
    if (!inAfter.has(r.key)) {
      out.push({ key: r.key, change: 'removed', before: cellTexts(r.cells), after: null })
    }
  }
  return out
}

const shownValue = (block: DocumentBlock | undefined): string | null =>
  block?.kind === 'value' ? block.cell.text : block?.kind === 'static' ? block.text : null

const summaryChange = (parts: ReadonlyArray<{ change: string }>, same: boolean): DiffChange =>
  same && parts.every((p) => p.change === 'unchanged') ? 'unchanged' : 'changed'

function diffBlock(before: DocumentBlock | undefined, after: DocumentBlock | undefined): BlockDiff {
  const block = (after ?? before) as DocumentBlock
  const whole: DiffChange | null =
    before === undefined ? 'added' : after === undefined ? 'removed' : null
  const same = before !== undefined && canonicalJson(before) === canonicalJson(after)
  switch (block.kind) {
    case 'text': {
      const segments = alignSegments(
        before?.kind === 'text' ? before.segments : [],
        after?.kind === 'text' ? after.segments : [],
      )
      return {
        id: block.id,
        kind: 'text',
        change: whole ?? summaryChange(segments, same),
        segments,
      }
    }
    case 'table':
    case 'list': {
      const rows = diffRows(before, after)
      return { id: block.id, kind: block.kind, change: whole ?? summaryChange(rows, same), rows }
    }
    default:
      return {
        id: block.id,
        kind: block.kind,
        change: whole ?? (same ? 'unchanged' : 'changed'),
        value: { before: shownValue(before), after: shownValue(after) },
      }
  }
}

/** Items of two lists by id, in the order of the newer one, the removed ones where they were. */
function aligned<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): Array<[T | undefined, T | undefined]> {
  const old = new Map(before.map((x) => [x.id, x]))
  const now = new Set(after.map((x) => x.id))
  const out: Array<[T | undefined, T | undefined]> = []
  let k = 0
  for (const x of after) {
    // The removed items that came before this one in the older list.
    while (k < before.length) {
      const b = before[k] as T
      if (now.has(b.id)) break
      out.push([b, undefined])
      k++
    }
    if (k < before.length && (before[k] as T).id === x.id) k++
    out.push([old.get(x.id), x])
  }
  for (; k < before.length; k++) {
    const b = before[k] as T
    if (!now.has(b.id)) out.push([b, undefined])
  }
  return out
}

function diffSection(before: Section | undefined, after: Section | undefined): SectionDiff {
  const section = (after ?? before) as Section
  const blocks = aligned(before?.blocks ?? [], after?.blocks ?? []).map(([b, a]) => diffBlock(b, a))
  const whole: DiffChange | null =
    before === undefined ? 'added' : after === undefined ? 'removed' : null
  const same = before?.title === after?.title && before?.notDeduced === after?.notDeduced
  return {
    id: section.id,
    title: section.title,
    change: whole ?? summaryChange(blocks, same),
    blocks,
  }
}

/** The differences between two revisions of a draft, for «Mostra differenze». */
export function diffRevisions(
  before: DeliverableDocument,
  after: DeliverableDocument,
): RevisionDiff {
  const sections = aligned(before.sections, after.sections).map(([b, a]) => diffSection(b, a))
  const internalNotes = alignSegments(before.internalNotes, after.internalNotes)
  const title = {
    before: before.title,
    after: after.title,
    change: before.title === after.title ? ('unchanged' as const) : ('changed' as const),
  }
  return {
    changed:
      title.change === 'changed' ||
      sections.some((s) => s.change !== 'unchanged') ||
      internalNotes.some((s) => s.change !== 'unchanged'),
    title,
    sections,
    internalNotes,
  }
}
