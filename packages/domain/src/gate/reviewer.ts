import { z } from 'zod'
import { canonicalText } from '../canonical.ts'
import type { Recipe } from '../recipe/format.ts'
import { canonicalHash } from '../recipe/hash.ts'
import type { InternalDocument } from './audience.ts'
import { segmentFingerprint } from './draft.ts'
import {
  type RedTeamAnomaly,
  type RedTeamPlace,
  type RedTeamRef,
  refKeyOf,
} from './red-team-model.ts'

// The findings of the model reviewer, a separate call on the rendered draft with the rules of
// the recipe («controlli del revisore»). Its findings are always anomalies of class `data`, and
// each must point at a place of the draft: one without a place, or with a place the draft does
// not have, is discarded and counted. The reviewer proposes no correction (nothing it writes but
// the place, the rule and its message is kept) and it can only add: what the code found stays.

/** Findings kept from one answer of the reviewer, at most. */
export const MAX_REVIEWER_FINDINGS = 50
/** Longest message of a finding, in characters. */
export const MAX_REVIEWER_MESSAGE = 500

const where = z.object({
  section: z.string(),
  block: z.string().nullable().optional(),
  /** 1-based position of the segment in a text block. */
  segment: z.int().min(1).nullable().optional(),
  row: z.string().nullable().optional(),
  column: z.string().nullable().optional(),
})

const finding = z.object({
  /** 0-based index of the rule among the `redTeamRules` of the recipe. */
  rule: z.int().min(0).nullable().optional(),
  where: where.nullable().optional(),
  message: z.string(),
})

export type ReviewerFinding = z.infer<typeof finding>

export interface ReviewerAdmission {
  admitted: RedTeamAnomaly[]
  /** Findings without a place, with a place the draft does not have, or beyond the limit. */
  discarded: number
}

function locate(
  w: z.infer<typeof where>,
  doc: InternalDocument,
): { ref: RedTeamRef; place: RedTeamPlace; content: unknown; slot: string | null } | null {
  const section = doc.sections.find((s) => s.id === w.section)
  if (section === undefined) return null
  const sPlace: RedTeamPlace = { section: section.title }
  if (w.block == null) {
    if (w.segment != null || w.row != null || w.column != null) return null
    return {
      ref: { element: 'section', section: section.id },
      place: sPlace,
      content: section,
      slot: null,
    }
  }
  const block = section.blocks.find((b) => b.id === w.block)
  if (block === undefined) return null
  const label =
    block.kind === 'value' ? block.label : block.kind === 'static' ? undefined : block.title
  const bPlace: RedTeamPlace = label === undefined ? sPlace : { ...sPlace, block: label }
  const slot = block.kind === 'text' ? block.id : null
  if (w.segment != null) {
    if (block.kind !== 'text' || w.row != null || w.column != null) return null
    const seg = block.segments[w.segment - 1]
    if (seg === undefined) return null
    return {
      ref: {
        element: 'segment',
        section: section.id,
        block: block.id,
        segment: segmentFingerprint(seg),
      },
      place: bPlace,
      content: seg,
      slot,
    }
  }
  if (w.row != null || w.column != null) {
    if (block.kind !== 'table' && block.kind !== 'list') return null
    const columnIndex = w.column == null ? -1 : block.columns.findIndex((c) => c.id === w.column)
    if (w.column != null && columnIndex < 0) return null
    const column = block.columns[columnIndex]
    const cPlace = column === undefined ? bPlace : { ...bPlace, column: column.title }
    if (w.row == null) {
      return {
        ref: { element: 'column', section: section.id, block: block.id, column: column?.id ?? '' },
        place: cPlace,
        content: (block.kind === 'table' ? block.rows : block.items).map(
          (r) => r.cells[columnIndex],
        ),
        slot: null,
      }
    }
    const row = (block.kind === 'table' ? block.rows : block.items).find((r) => r.key === w.row)
    if (row === undefined) return null
    if (column === undefined) {
      return {
        ref: { element: 'row', section: section.id, block: block.id, row: row.key },
        place: bPlace,
        content: row,
        slot: null,
      }
    }
    return {
      ref: {
        element: 'cell',
        section: section.id,
        block: block.id,
        row: row.key,
        column: column.id,
      },
      place: cPlace,
      content: row.cells[columnIndex],
      slot: null,
    }
  }
  return {
    ref: { element: 'block', section: section.id, block: block.id },
    place: bPlace,
    content: block,
    slot,
  }
}

/**
 * The findings of the reviewer the red-team keeps: each with a place of the draft, of class
 * `data`, bound to the content of that place and to its rule. Anything else it wrote is dropped.
 */
export function admitReviewerFindings(
  raw: unknown,
  doc: InternalDocument,
  recipe: Recipe,
): ReviewerAdmission {
  const list = Array.isArray(raw) ? raw : []
  const admitted: RedTeamAnomaly[] = []
  const seen = new Set<string>()
  let discarded = 0
  for (const item of list) {
    const parsed = finding.safeParse(item)
    const message = parsed.success ? canonicalText(parsed.data.message) : ''
    const located = parsed.success && parsed.data.where ? locate(parsed.data.where, doc) : null
    const rule = parsed.success ? (parsed.data.rule ?? null) : null
    if (
      !parsed.success ||
      located === null ||
      message === '' ||
      (rule !== null && rule >= recipe.redTeamRules.length)
    ) {
      discarded++
      continue
    }
    const refKey = refKeyOf(located.ref)
    const once = `${refKey}\u0000${rule ?? ''}`
    // The same place and rule twice is one finding.
    if (seen.has(once)) continue
    seen.add(once)
    if (admitted.length >= MAX_REVIEWER_FINDINGS) {
      discarded++
      continue
    }
    admitted.push({
      code: 'reviewer_finding',
      gate: null,
      class: 'data',
      ref: located.ref,
      refKey,
      contentHash: canonicalHash({ rule, content: located.content }),
      place: located.place,
      slot: located.slot,
      resolution: 'acceptance',
      status: 'open',
      detail: { rule, message: [...message].slice(0, MAX_REVIEWER_MESSAGE).join('') },
    })
  }
  return { admitted, discarded }
}
