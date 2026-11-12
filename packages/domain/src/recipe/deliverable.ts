import type { ClientDocument, ClientNoteTrace, InternalDocument } from '../gate/audience.ts'
import { declaredCellId, declaredPeriod } from '../gate/common-gates.ts'
import type { Lang } from '../language/index.ts'
import type {
  DeliverableDocument,
  DocumentBlock,
  DocumentCell,
  DocumentSection,
} from './document-model.ts'
import type { Recipe, RecipeAudience, RecipeRender, RenderFormat } from './format.ts'
import { canonicalJson } from './hash.ts'
import { recipeText } from './messages/index.ts'
import type { RenderCheckOutcome, RenderFinding, RenderLayout } from './render.ts'
import { RENDER_FINDINGS } from './render.ts'
import { shownDraft } from './shown-draft.ts'
import { TEMPLATE_REFUSALS, type TemplateFormat, type TemplateRefusal } from './template.ts'

// The files of an approved deliverable, as the code makes them: the Markdown is written here, in
// the same way every time; the binary file is the renderer's, from the same document. The
// internal file shows the full titles of the sources and the notes for the PM; the client file is
// the client version frozen with the approval, with generic source notes and no internal note.
// Nothing here reads a clock, the environment or the network.

/** Whom a file is for. */
export const FILE_AUDIENCES = ['internal', 'client'] as const
export type FileAudience = (typeof FILE_AUDIENCES)[number]

/** The files of a recipe for an audience: `both` gives the internal one and the client one. */
export function fileAudiences(audience: RecipeAudience): FileAudience[] {
  switch (audience) {
    case 'internal':
      return ['internal']
    case 'client':
      return ['client']
    case 'both':
      return ['internal', 'client']
  }
}

/** The binary format of a recipe, beside the Markdown it always has; null for Markdown only. */
export function binaryFormatOf(render: Pick<RecipeRender, 'formats'>): TemplateFormat | null {
  const binary = render.formats.filter((f): f is TemplateFormat => f !== 'md')
  return binary[0] ?? null
}

/** The fixed content type of a file of each format: never the one of an upload or a guess. */
export const DELIVERABLE_CONTENT_TYPES: Readonly<Record<RenderFormat, string>> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

const AUDIENCE_WORDS: Readonly<Record<FileAudience, string>> = {
  internal: 'interno',
  client: 'cliente',
}

/**
 * The name a file is downloaded with: the slug and version of the recipe, whom it is for and the
 * format, in letters, digits, dots and dashes only (nothing a header or a file system reads as
 * something else).
 */
export function deliverableFileName(
  doc: Pick<DeliverableDocument, 'recipe'>,
  audience: FileAudience,
  format: RenderFormat,
): string {
  const safe = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
  const base = [safe(doc.recipe.slug), safe(doc.recipe.version), AUDIENCE_WORDS[audience]]
    .filter((p) => p !== '')
    .join('-')
  return `${base || 'documento'}.${format}`
}

// The document of a file --------------------------------------------------------------------------

/**
 * What makes two notes one. In the internal file: the same title and date of the same source (a
 * piece of evidence whatever its place, or the same row, item, fact or parameter), never two
 * sources that only share a title. In the client file, whose notes are generic and carry no
 * place: the same words and date.
 */
function noteKey(n: DeliverableDocument['sourceNotes'][number]): string {
  if (!('ref' in n)) return canonicalJson([n.label, n.dataAsOf])
  const source = n.ref.kind === 'evidence' ? { kind: 'evidence', id: n.ref.evidenceId } : n.ref
  return canonicalJson([n.label, n.dataAsOf, source])
}

/**
 * The source notes of a file, each once: notes of the same source that read the same (two places
 * of one piece of evidence) become one, numbered in the order they first appear, and every datum
 * cites each of its notes once.
 */
function dedupeNotes(doc: DeliverableDocument): DeliverableDocument {
  const byText = new Map<string, number>()
  const renumber = new Map<number, number>()
  const kept: DeliverableDocument['sourceNotes'][number][] = []
  for (const note of doc.sourceNotes) {
    const key = noteKey(note)
    let n = byText.get(key)
    if (n === undefined) {
      n = kept.length + 1
      byText.set(key, n)
      kept.push({ ...note, n })
    }
    renumber.set(note.n, n)
  }
  const map = (sources: readonly number[]) => sources.map((s) => renumber.get(s) ?? s)
  const cell = (c: DocumentCell): DocumentCell => {
    const sources = [...new Set(map(c.sources))]
    return { ...c, sources }
  }
  const block = (b: DocumentBlock): DocumentBlock => {
    switch (b.kind) {
      case 'value':
        return { ...b, cell: cell(b.cell) }
      case 'table':
        return { ...b, rows: b.rows.map((r) => ({ ...r, cells: r.cells.map(cell) })) }
      case 'list':
        return { ...b, items: b.items.map((r) => ({ ...r, cells: r.cells.map(cell) })) }
      case 'text':
        // A segment keeps one category per cited source: the sources keep their positions.
        return { ...b, segments: b.segments.map((s) => ({ ...s, sources: map(s.sources) })) }
      default:
        return b
    }
  }
  return {
    ...doc,
    sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(block) })),
    sourceNotes: kept,
    internalNotes: doc.internalNotes.map((s) => ({ ...s, sources: map(s.sources) })),
  } as DeliverableDocument
}

/**
 * The document a file is made from: the figures that cite a note of a source past the stop
 * threshold suspended (the same rule as the draft shown to the PM), then the notes each once.
 */
export function fileDocument<D extends DeliverableDocument>(
  doc: D,
  suspended: readonly number[],
  lang: Lang,
): D {
  return dedupeNotes(shownDraft(doc, suspended, lang)) as D
}

/**
 * The notes of the client version whose figures are suspended: those that stand for a place
 * cited by a suspended note of the internal draft.
 */
export function clientSuspendedNotes(
  internal: InternalDocument,
  suspended: readonly number[],
  traces: readonly ClientNoteTrace[],
): number[] {
  if (suspended.length === 0) return []
  const refs = new Set(
    internal.sourceNotes.filter((n) => suspended.includes(n.n)).map((n) => canonicalJson(n.ref)),
  )
  return traces
    .filter((t) => t.refs.some((r) => refs.has(canonicalJson(r))))
    .map((t) => t.n)
    .sort((a, b) => a - b)
}

/**
 * The layout of the recipe for one file: only the sections and the named cells the document
 * holds (an internal section or a withheld column is not in the client version), so the
 * renderer is never asked for a part that is not there.
 */
export function fileLayout(layout: RenderLayout, doc: DeliverableDocument): RenderLayout {
  const sections = new Set(doc.sections.map((s) => s.id))
  const blocks = new Map<string, DocumentBlock>()
  for (const s of doc.sections) for (const b of s.blocks) blocks.set(b.id, b)
  return {
    sections: layout.sections.filter((s) => sections.has(s.section)),
    namedCells: layout.namedCells.filter((c) => {
      const block = blocks.get(c.block)
      if (block === undefined) return false
      if (c.column === undefined) return true
      return (
        (block.kind === 'table' || block.kind === 'list') &&
        block.columns.some((col) => col.id === c.column)
      )
    }),
  }
}

// Values declared to the client --------------------------------------------------------------------

/** A value of the client version as it is declared, for gate 10 of the runs that follow. */
export interface FileDeclaredValue {
  sectionId: string
  cellId: string
  value: string
  period: string | null
}

/**
 * The values the client file shows: every value and every cell of a table or a list of the client
 * version, with its text. A cell «non dedotto» or suspended shows no value and declares none.
 */
export function clientDeclaredValues(
  client: ClientDocument,
  recipe: Recipe,
  periods: Readonly<Record<string, { from: string; to: string }>>,
): FileDeclaredValue[] {
  const period = declaredPeriod(recipe, periods)
  const out: FileDeclaredValue[] = []
  for (const section of client.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'value') {
        if (block.cell.text !== null) {
          out.push({
            sectionId: section.id,
            cellId: declaredCellId(block.id),
            value: block.cell.text,
            period,
          })
        }
      } else if (block.kind === 'table' || block.kind === 'list') {
        const rows = block.kind === 'table' ? block.rows : block.items
        for (const row of rows) {
          row.cells.forEach((cell, i) => {
            const column = block.columns[i]
            if (column === undefined || cell.text === null) return
            out.push({
              sectionId: section.id,
              cellId: declaredCellId(block.id, column.id, row.key),
              value: cell.text,
              period,
            })
          })
        }
      }
    }
  }
  return out
}

// Markdown ---------------------------------------------------------------------------------------

export type DeliverableTextKey =
  | 'sources_title'
  | 'internal_notes_title'
  | 'data_as_of'
  | 'data_as_of_unknown'
  | 'not_deduced'
  | 'note'
  | 'note_undated'
  | RenderFailureCode

const ROME_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** An instant as the PM reads it, in the time of Rome: «05/11/2026 09:00», as the renderer does. */
export function fileInstant(instant: string): string {
  const p: Record<string, string> = {}
  for (const part of ROME_PARTS.formatToParts(new Date(instant))) p[part.type] = part.value
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`
}

/**
 * Text of a source, taken as text: nothing in it becomes a link, a heading, a table or a list
 * (a line that starts like an item of a list keeps its mark as text).
 */
function escaped(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()<>#+!|~]/g, '\\$&')
    .replace(/^(\s*)([-=])(?=\s|$)/gm, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/gm, '$1\\$2')
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The notes a datum cites, each once and in order: ` [1][2]`. */
function marks(sources: readonly number[]): string {
  const ns = [...new Set(sources)].sort((a, b) => a - b)
  return ns.length === 0 ? '' : ` ${ns.map((n) => `[${n}]`).join('')}`
}

function cellText(cell: DocumentCell, lang: Lang): string {
  if (cell.text === null) return `_${recipeText('deliverable', 'not_deduced', {}, lang)}_`
  return `${escaped(oneLine(cell.text))}${marks(cell.sources)}`
}

function blockText(block: DocumentBlock, lang: Lang): string {
  const notDeduced = `_${recipeText('deliverable', 'not_deduced', {}, lang)}_`
  const titled = (body: string) =>
    'title' in block && block.title !== undefined ? `### ${escaped(block.title)}\n\n${body}` : body
  switch (block.kind) {
    case 'static':
      return escaped(block.text)
    case 'value':
      return `**${escaped(block.label)}:** ${cellText(block.cell, lang)}`
    case 'text': {
      if (block.notDeduced || block.segments.length === 0) return titled(notDeduced)
      return titled(block.segments.map((s) => `${escaped(s.text)}${marks(s.sources)}`).join(' '))
    }
    case 'list': {
      if (block.notDeduced || block.items.length === 0) return titled(notDeduced)
      return titled(
        block.items.map((i) => `- ${i.cells.map((c) => cellText(c, lang)).join(' — ')}`).join('\n'),
      )
    }
    case 'table': {
      if (block.notDeduced || block.rows.length === 0) return titled(notDeduced)
      const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`
      const head = line(block.columns.map((c) => escaped(oneLine(c.title))))
      const rule = `|${block.columns.map(() => ' --- ').join('|')}|`
      const rows = block.rows.map((row) => line(row.cells.map((c) => cellText(c, lang))))
      return titled([head, rule, ...rows].join('\n'))
    }
  }
}

function sectionText(section: DocumentSection, lang: Lang): string {
  const title = `## ${escaped(section.title)}`
  if (section.notDeduced) {
    return `${title}\n\n_${recipeText('deliverable', 'not_deduced', {}, lang)}_`
  }
  return [title, ...section.blocks.map((b) => blockText(b, lang))].join('\n\n')
}

/**
 * The Markdown of a file, the same for the same document: the title, «Dati al …, generato il …»,
 * the sections, the numbered source notes and, in the internal file only, the notes for the PM.
 * Places, ids and paths of the sources never appear: a note shows its title and its date.
 */
export function renderMarkdown(doc: DeliverableDocument): string {
  const lang = doc.lang
  const asOf = doc.header.dataAsOf
  const header = recipeText(
    'deliverable',
    asOf === null ? 'data_as_of_unknown' : 'data_as_of',
    {
      ...(asOf === null ? {} : { asOf: fileInstant(asOf) }),
      generated: fileInstant(doc.header.generatedAt),
    },
    lang,
  )
  const parts = [`# ${escaped(doc.title)}`, `_${header}_`]
  for (const section of doc.sections) parts.push(sectionText(section, lang))
  if (doc.sourceNotes.length > 0) {
    // The generic note of the client version already says the day of its data.
    const dated = doc.audience === 'internal'
    const lines = doc.sourceNotes.map((n) =>
      recipeText(
        'deliverable',
        n.dataAsOf === null || !dated ? 'note_undated' : 'note',
        {
          n: n.n,
          label: escaped(n.label),
          ...(n.dataAsOf === null ? {} : { asOf: fileInstant(n.dataAsOf) }),
        },
        lang,
      ),
    )
    parts.push(`## ${recipeText('deliverable', 'sources_title', {}, lang)}`, lines.join('\n'))
  }
  if (doc.audience === 'internal' && doc.internalNotes.length > 0) {
    parts.push(
      `## ${recipeText('deliverable', 'internal_notes_title', {}, lang)}`,
      doc.internalNotes.map((s) => `- ${escaped(s.text)}${marks(s.sources)}`).join('\n'),
    )
  }
  return `${parts.join('\n\n')}\n`
}

// Why a render did not give the files --------------------------------------------------------------

/** Why the job made no file, besides what a check of the renderer found. */
export const RENDER_FAILURE_CODES = [
  /** The renderer did not answer, after the retries. */
  'renderer_unavailable',
  /** The document is not the one approved. */
  'document_changed',
  /** The client version projected again is not the one frozen with the approval. */
  'client_version_changed',
  /** The recipe or the settings of the run cannot be found as the run used them. */
  'recipe_unavailable',
  /** The template of the run is not in the library or the project any more. */
  'template_missing',
  /** A check of the file failed without a finding the PM has words for. */
  'file_check_failed',
  /** The files were made but could not be stored, after the retries. */
  'file_not_stored',
  /** Something else went wrong while making the files: an error of the code, or a deadline. */
  'render_error',
  /** Closed by the sweep: the job never settled the render within its lifetime. */
  'render_stuck',
] as const
export type RenderFailureCode = (typeof RENDER_FAILURE_CODES)[number]

/** The reason of a failed render: a code of the job, or what a check of the renderer found. */
export type RenderFailure = RenderFailureCode | RenderFinding | TemplateRefusal

const isFailureCode = (code: string): code is RenderFailureCode =>
  (RENDER_FAILURE_CODES as readonly string[]).includes(code)
const isFinding = (code: string): code is RenderFinding =>
  (RENDER_FINDINGS as readonly string[]).includes(code)
const isRefusal = (code: string): code is TemplateRefusal =>
  (TEMPLATE_REFUSALS as readonly string[]).includes(code)

/** Whether a stored code is the reason of a failed render. */
export function isRenderFailure(code: string): code is RenderFailure {
  return isFailureCode(code) || isFinding(code) || isRefusal(code)
}

/** The first thing a check of the renderer found, as the reason of the failure. */
export function renderFailureOf(checks: readonly RenderCheckOutcome[]): RenderFailure {
  for (const c of checks) {
    if (c.passed) continue
    const found = c.findings.find((f) => isRenderFailure(f))
    if (found !== undefined) return found
  }
  return 'file_check_failed'
}

/** The words of a PM for the reason of a failed render: never a code. */
export function renderFailureText(code: string, lang: Lang): string {
  if (isFailureCode(code)) return recipeText('deliverable', code, {}, lang)
  if (isFinding(code)) return recipeText('render', code, {}, lang)
  if (isRefusal(code)) return recipeText('templates', code, {}, lang)
  return recipeText('deliverable', 'file_check_failed', {}, lang)
}
