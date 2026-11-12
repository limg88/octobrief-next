import type { DeliverableDocument } from './document-model.ts'
import type { RecipeRender } from './format.ts'
import type { TemplateFormat, TemplateRefusal } from './template.ts'

// The request to the renderer and what it answers. The renderer is a separate container without
// network, database or secrets: it receives the approved document, the bytes of the template with
// the layout of the recipe, and the counts the file must have. The counts are computed here, from
// the document, so the check of the file does not depend on whoever renders it.

/** The layout of the recipe the renderer follows: styles, slide layouts, sheets, named cells. */
export type RenderLayout = Pick<RecipeRender, 'sections' | 'namedCells'>

/**
 * What the file must hold, counted by the renderer in the file it produced:
 * - docx: `sections`, the headings of the sections (one more for the source notes and one for
 *   the notes for the PM, when there are any), and `tables`, one per table block;
 * - pptx: `slides`, a title slide, one per section and one per kind of notes, and `tables`;
 * - xlsx: `tables`, a workbook table per table block, or, for a form, only `namedCells`.
 */
export type RenderCounts =
  | { sections: number; tables: number }
  | { slides: number; tables: number }
  | { tables: number; namedCells: number }

export interface RenderEnvelope {
  document: DeliverableDocument
  format: TemplateFormat
  template: { data: string; layout: RenderLayout }
  expected: RenderCounts
}

/** The checks of the `binary` phase, as the renderer reports them. */
export const RENDER_CHECKS = [
  'request',
  'document',
  'template',
  'layout',
  'render',
  'opens',
  'active_content',
  'formulas',
  'template_parts',
  'counts',
] as const
export type RenderCheck = (typeof RENDER_CHECKS)[number]

/** What a check of the renderer found, beyond the refusals of a template. */
export const RENDER_FINDINGS = [
  'request_invalid',
  'request_too_large',
  'document_invalid',
  'layout_unknown_block',
  'layout_style_missing',
  'layout_slide_layout_missing',
  'layout_sheet_missing',
  'named_cell_missing',
  'render_failed',
  'render_timeout',
  'file_unreadable',
  'file_too_large',
  'file_formula',
  'template_part_changed',
  'count_mismatch',
] as const
export type RenderFinding = (typeof RENDER_FINDINGS)[number]

export interface RenderCheckOutcome {
  /** What was checked: the request, the template as received, or the file produced. */
  subject: 'request' | 'template' | 'file'
  check: RenderCheck
  passed: boolean
  findings: (RenderFinding | TemplateRefusal)[]
}

/** The answer of the renderer: the file only when every check passed, never otherwise. */
export type RenderResponse =
  | { outcome: 'rendered'; file: string; sha256: string; checks: RenderCheckOutcome[] }
  | { outcome: 'refused'; checks: RenderCheckOutcome[] }

const extraHeadings = (document: DeliverableDocument): number =>
  (document.sourceNotes.length > 0 ? 1 : 0) + (document.internalNotes.length > 0 ? 1 : 0)

const tableBlocks = (document: DeliverableDocument): number =>
  document.sections.reduce(
    (n, section) => n + section.blocks.filter((b) => b.kind === 'table').length,
    0,
  )

/** The counts the file of `document` must have in `format` with `layout`. */
export function expectedRenderCounts(
  document: DeliverableDocument,
  format: TemplateFormat,
  layout: RenderLayout,
): RenderCounts {
  switch (format) {
    case 'docx':
      return {
        sections: document.sections.length + extraHeadings(document),
        tables: tableBlocks(document),
      }
    case 'pptx':
      return {
        slides: 1 + document.sections.length + extraHeadings(document),
        tables: tableBlocks(document),
      }
    case 'xlsx':
      return layout.namedCells.length > 0
        ? { tables: 0, namedCells: layout.namedCells.length }
        : { tables: tableBlocks(document), namedCells: 0 }
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(n >> 18) & 63]
    out += BASE64[(n >> 12) & 63]
    out += b === undefined ? '=' : BASE64[(n >> 6) & 63]
    out += c === undefined ? '=' : BASE64[n & 63]
  }
  return out
}

/** The request for the file of an approved document, with the counts it must have. */
export function renderEnvelope(
  document: DeliverableDocument,
  format: TemplateFormat,
  template: Uint8Array,
  layout: RenderLayout,
): RenderEnvelope {
  return {
    document,
    format,
    template: { data: base64(template), layout },
    expected: expectedRenderCounts(document, format, layout),
  }
}
