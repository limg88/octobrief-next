import type { Acceptance } from '../gate/acceptance.ts'
import { type PmDecision, statusOf } from '../gate/decisions.ts'
import type { RedTeamRow } from '../gate/red-team.ts'
import type { Lang } from '../language/index.ts'
import type { DeliverableDocument, DocumentBlock, DocumentCell } from './document-model.ts'
import { recipeText } from './messages/index.ts'

// The draft as the PM is shown it. A source past the stop threshold of freshness is one anomaly
// of data (`stale_source`) listing the notes that cite it: while it is open, every figure that
// cites one of those notes is suspended, never shown as if it were current. The stored revision
// is not touched: the file side applies the same rule when it renders.

/** The notes whose figures are suspended: those of the open `stale_source` anomalies. */
export function suspendedNotes(
  rows: readonly RedTeamRow[],
  acceptances: readonly Acceptance[],
  decisions: readonly PmDecision[],
): number[] {
  const out = new Set<number>()
  for (const r of rows) {
    if (r.outcome !== 'anomaly' || r.code !== 'stale_source') continue
    const status = statusOf(
      { code: r.code, refKey: r.ref, contentHash: r.contentHash },
      acceptances,
      decisions,
    )
    if (status !== 'open') continue
    const notes = r.detail.notes
    if (!Array.isArray(notes)) continue
    for (const n of notes) if (typeof n === 'number' && Number.isInteger(n)) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * The draft with its suspended figures taken out: a cell or a value that cites a suspended note
 * shows no figure («non dedotto» until the source is current again), a segment that cites one
 * shows the sentence of the suspension instead of its text.
 */
export function shownDraft(
  doc: DeliverableDocument,
  suspended: readonly number[],
  lang: Lang,
): DeliverableDocument {
  if (suspended.length === 0) return doc
  const notes = new Set(suspended)
  const hit = (sources: readonly number[]) => sources.some((n) => notes.has(n))
  const cell = (c: DocumentCell): DocumentCell => (hit(c.sources) ? { ...c, text: null } : c)
  const sentence = recipeText('run', 'suspended_data', {}, lang)
  const block = (b: DocumentBlock): DocumentBlock => {
    switch (b.kind) {
      case 'value':
        return { ...b, cell: cell(b.cell) }
      case 'table':
        return { ...b, rows: b.rows.map((r) => ({ ...r, cells: r.cells.map(cell) })) }
      case 'list':
        return { ...b, items: b.items.map((r) => ({ ...r, cells: r.cells.map(cell) })) }
      case 'text':
        return {
          ...b,
          segments: b.segments.map((s) => (hit(s.sources) ? { ...s, text: sentence } : s)),
        }
      default:
        return b
    }
  }
  return {
    ...doc,
    sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(block) })),
  } as DeliverableDocument
}
