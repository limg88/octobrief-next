import type {
  DocumentBlock,
  DocumentCell,
  DocumentSegment,
  SourceNote,
} from '../recipe/document-model.ts'
import type { Recipe, RecipeBlock, RecipeSection } from '../recipe/format.ts'
import { canonicalHash } from '../recipe/hash.ts'
import type { InternalDocument } from './audience.ts'
import type { RedTeamAnomaly, RedTeamPlace, RedTeamRef } from './red-team-model.ts'

// Every element of a draft the gates look at, once, with its place: titles, fixed texts,
// segments of the slots, cells, values, notes for the PM and source notes.

interface Base {
  ref: RedTeamRef
  place: RedTeamPlace
  /** The text slot the element is in. */
  slot: string | null
}

export type DraftElement =
  | (Base & { kind: 'title'; text: string; recipeTitle: string | null })
  | (Base & { kind: 'static'; text: string; recipeText: string | null })
  | (Base & { kind: 'segment'; segment: DocumentSegment })
  | (Base & { kind: 'cell'; cell: DocumentCell })
  | (Base & { kind: 'internal_note'; segment: DocumentSegment })
  | (Base & { kind: 'source_note'; note: SourceNote })

/** The fingerprint of a segment: its text and nature. */
export function segmentFingerprint(seg: Pick<DocumentSegment, 'text' | 'nature'>): string {
  return canonicalHash({ text: seg.text, nature: seg.nature })
}

export function recipeSectionOf(recipe: Recipe, id: string): RecipeSection | undefined {
  return recipe.sections.find((s) => s.id === id)
}

export function recipeBlockOf(
  section: RecipeSection | undefined,
  id: string,
): RecipeBlock | undefined {
  return section?.blocks.find((b) => b.id === id)
}

function blockTitleOf(b: RecipeBlock | undefined): string | null {
  if (b === undefined) return null
  if (b.kind === 'data_value') return b.label
  if (b.kind === 'static') return null
  return b.title ?? null
}

function columnTitleOf(b: RecipeBlock | undefined, column: string): string | null {
  if (b === undefined || (b.kind !== 'data_table' && b.kind !== 'data_list')) return null
  return b.columns.find((c) => c.id === column)?.title ?? null
}

function blockLabel(b: DocumentBlock): string | undefined {
  if (b.kind === 'value') return b.label
  if (b.kind === 'static') return undefined
  return b.title
}

/** The elements of an internal draft, in the order of the document. */
export function draftElements(doc: InternalDocument, recipe: Recipe): DraftElement[] {
  const out: DraftElement[] = []
  out.push({
    kind: 'title',
    text: doc.title,
    recipeTitle: recipe.title,
    ref: { element: 'document_title' },
    place: {},
    slot: null,
  })
  for (const section of doc.sections) {
    const rs = recipeSectionOf(recipe, section.id)
    const sPlace: RedTeamPlace = { section: section.title }
    out.push({
      kind: 'title',
      text: section.title,
      recipeTitle: rs?.title ?? null,
      ref: { element: 'section_title', section: section.id },
      place: sPlace,
      slot: null,
    })
    for (const block of section.blocks) {
      const rb = recipeBlockOf(rs, block.id)
      const label = blockLabel(block)
      const bPlace: RedTeamPlace = label === undefined ? sPlace : { ...sPlace, block: label }
      if (label !== undefined && block.kind !== 'value') {
        out.push({
          kind: 'title',
          text: label,
          recipeTitle: blockTitleOf(rb),
          ref: { element: 'block_title', section: section.id, block: block.id },
          place: bPlace,
          slot: null,
        })
      }
      switch (block.kind) {
        case 'static':
          out.push({
            kind: 'static',
            text: block.text,
            recipeText: rb?.kind === 'static' ? rb.text : null,
            ref: { element: 'static', section: section.id, block: block.id },
            place: bPlace,
            slot: null,
          })
          break
        case 'text':
          for (const segment of block.segments) {
            out.push({
              kind: 'segment',
              segment,
              ref: {
                element: 'segment',
                section: section.id,
                block: block.id,
                segment: segmentFingerprint(segment),
              },
              place: bPlace,
              slot: block.id,
            })
          }
          break
        case 'value':
          out.push({
            kind: 'title',
            text: block.label,
            recipeTitle: blockTitleOf(rb),
            ref: { element: 'block_title', section: section.id, block: block.id },
            place: bPlace,
            slot: null,
          })
          out.push({
            kind: 'cell',
            cell: block.cell,
            ref: { element: 'value', section: section.id, block: block.id },
            place: bPlace,
            slot: null,
          })
          break
        case 'table':
        case 'list': {
          const rows = block.kind === 'table' ? block.rows : block.items
          for (const column of block.columns) {
            out.push({
              kind: 'title',
              text: column.title,
              recipeTitle: columnTitleOf(rb, column.id),
              ref: { element: 'column', section: section.id, block: block.id, column: column.id },
              place: { ...bPlace, column: column.title },
              slot: null,
            })
          }
          for (const row of rows) {
            row.cells.forEach((cell, i) => {
              const column = block.columns[i]
              out.push({
                kind: 'cell',
                cell,
                ref: {
                  element: 'cell',
                  section: section.id,
                  block: block.id,
                  row: row.key,
                  column: column?.id ?? String(i + 1),
                },
                place: column === undefined ? bPlace : { ...bPlace, column: column.title },
                slot: null,
              })
            })
          }
          break
        }
      }
    }
  }
  for (const segment of doc.internalNotes) {
    out.push({
      kind: 'internal_note',
      segment,
      ref: { element: 'internal_note', segment: segmentFingerprint(segment) },
      place: {},
      slot: null,
    })
  }
  for (const note of doc.sourceNotes) {
    out.push({
      kind: 'source_note',
      note,
      ref: { element: 'source_note', label: note.label },
      place: {},
      slot: null,
    })
  }
  return out
}

/**
 * The key of a text of the draft, as the draft shows it: its slot (null for a note for the PM)
 * and its fingerprint.
 */
export function draftSegmentKey(
  slot: string | null,
  seg: Pick<DocumentSegment, 'text' | 'nature'>,
): string {
  return JSON.stringify([slot, segmentFingerprint(seg)])
}

/**
 * The texts of the draft an open anomaly says are without a verified source: the draft marks
 * them where they are, so the PM recognizes the text the anomaly is about.
 */
export function segmentsWithoutSource(
  anomalies: ReadonlyArray<Pick<RedTeamAnomaly, 'code' | 'ref' | 'status'>>,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const a of anomalies) {
    if (a.code !== 'without_source' || a.status !== 'open') continue
    if (a.ref.element === 'segment') out.add(JSON.stringify([a.ref.block, a.ref.segment]))
    else if (a.ref.element === 'internal_note') out.add(JSON.stringify([null, a.ref.segment]))
  }
  return out
}
