import type { RecipeCheck, SegmentSourceKind } from '../recipe/checks.ts'
import type { DocumentBlock, DocumentSourceRef } from '../recipe/document-model.ts'
import type { Recipe } from '../recipe/format.ts'
import type { InternalDocument } from './audience.ts'
import { phraseForm } from './internal-lexicon.ts'
import type { DetailObject } from './red-team-model.ts'

// The checks of the catalog on the segments of a text slot, run by the code: the kinds of place
// each segment cites («every decision cites the transcript»), and the fields a segment states
// («Responsabile: …», «Scadenza: …»), with a placeholder when nobody declared them. They read
// the form of the text and the notes it cites, never its meaning: whether the cited line really
// says what the segment says is the work of the verifier and of the model reviewer.

export type SegmentCheckOutcome =
  | { ok: true }
  | { ok: false; evaluable: boolean; content: unknown; detail?: DetailObject }

type TextBlock = Extract<DocumentBlock, { kind: 'text' }>
type SegmentCheck = Extract<RecipeCheck, { kind: 'segments_cited' | 'segment_fields' }>

const PASS: SegmentCheckOutcome = { ok: true }

function textBlock(doc: InternalDocument, id: string): TextBlock | null {
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.id === id) return block.kind === 'text' ? block : null
    }
  }
  return null
}

/**
 * The evidence a selection of the PM holds, as the draft shows it: what the rows of the blocks
 * that list the selection cite. A selection skipped, or a block «non dedotto», holds nothing.
 */
function selectedEvidence(doc: InternalDocument, recipe: Recipe, parameter: string): Set<string> {
  const blocks = new Set(
    recipe.sections.flatMap((s) =>
      s.blocks.flatMap((b) =>
        (b.kind === 'data_list' || b.kind === 'data_table') &&
        b.query.kind === 'parameter' &&
        b.query.parameter === parameter
          ? [b.id]
          : [],
      ),
    ),
  )
  const refs = new Map(doc.sourceNotes.map((n) => [n.n, n.ref]))
  const out = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (!blocks.has(block.id) || (block.kind !== 'list' && block.kind !== 'table')) continue
      const rows = block.kind === 'table' ? block.rows : block.items
      for (const row of rows) {
        for (const cell of row.cells) {
          for (const n of cell.sources) {
            const ref = refs.get(n)
            if (ref?.kind === 'evidence') out.add(ref.evidenceId)
          }
        }
      }
    }
  }
  return out
}

/** Whether a segment cites a place the check admits: of its kinds, and of its selection if any. */
function citer(
  doc: InternalDocument,
  recipe: Recipe,
  check: SegmentCheck,
): (sources: readonly number[]) => boolean {
  const refs = new Map<number, DocumentSourceRef>(doc.sourceNotes.map((n) => [n.n, n.ref]))
  const selected =
    check.parameter === undefined ? null : selectedEvidence(doc, recipe, check.parameter)
  const kinds: readonly SegmentSourceKind[] = check.sourceKinds
  return (sources) =>
    sources.some((n) => {
      const ref = refs.get(n)
      if (ref === undefined || !kinds.includes(ref.kind)) return false
      return selected === null || (ref.kind === 'evidence' && selected.has(ref.evidenceId))
    })
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Every place a text states a field: just after «<label>:», the label starting a word. */
function fieldStarts(t: string, l: string): number[] {
  if (l === '') return []
  const out: number[] = []
  let at = t.indexOf(l)
  while (at >= 0) {
    const before = at === 0 ? '' : (t[at - 1] as string)
    const rest = t.slice(at + l.length)
    const colon = rest.length - rest.trimStart().length
    if (!LETTER_OR_DIGIT.test(before) && rest[colon] === ':') out.push(at + l.length + colon + 1)
    at = t.indexOf(l, at + 1)
  }
  return out
}

/** The value a field states from `start`: up to a semicolon or the next of `others` fields. */
function valueFrom(t: string, start: number, others: readonly string[]): string | null {
  let end = t.indexOf(';', start)
  if (end < 0) end = t.length
  for (const other of others) {
    const o = phraseForm(other)
    const next = o === '' ? -1 : t.indexOf(`${o}:`, start)
    if (next >= 0 && next < end) end = next
  }
  const value = t.slice(start, end).trim()
  return LETTER_OR_DIGIT.test(value) ? value : null
}

/**
 * Every value a text states for a field, one per time it states it, in the form phrases are
 * compared in: the words after «<label>:», up to a semicolon or the next of `others` fields;
 * null for a field stated empty.
 */
export function fieldValues(
  text: string,
  label: string,
  others: readonly string[] = [],
): Array<string | null> {
  const t = phraseForm(text)
  return fieldStarts(t, phraseForm(label)).map((start) => valueFrom(t, start, others))
}

/**
 * Whether the value of a field is its placeholder and nothing else: «da assegnare (forse X)»
 * names someone, and is a value.
 */
const isPlaceholder = (value: string, placeholder: string): boolean =>
  value.replace(/[\s.,]+$/u, '') === phraseForm(placeholder)

/** Every segment of the slot cites a place the check admits. */
function segmentsCited(
  doc: InternalDocument,
  recipe: Recipe,
  check: Extract<RecipeCheck, { kind: 'segments_cited' }>,
): SegmentCheckOutcome {
  const block = textBlock(doc, check.slot)
  if (block === null) return { ok: false, evaluable: false, content: null }
  const cites = citer(doc, recipe, check)
  const content = block.segments.map((s) => [s.text, s.sources])
  const uncited = block.segments.filter((s) => !cites(s.sources))
  return uncited.length === 0
    ? PASS
    : { ok: false, evaluable: true, content, detail: { segments: uncited.length } }
}

/**
 * Every segment of the slot states each field of the check, once. A field left to its whole
 * placeholder («da assegnare») is fine; a field with a value needs the segment to cite a place
 * the check admits: an owner or a deadline nobody declared is never filled in. A field stated
 * twice is an anomaly whatever it says: which of the two holds is not for the code to choose.
 */
function segmentFields(
  doc: InternalDocument,
  recipe: Recipe,
  check: Extract<RecipeCheck, { kind: 'segment_fields' }>,
): SegmentCheckOutcome {
  const block = textBlock(doc, check.slot)
  if (block === null) return { ok: false, evaluable: false, content: null }
  const cites = citer(doc, recipe, check)
  let missing = 0
  let unsourced = 0
  let repeated = 0
  const content: unknown[] = []
  for (const s of block.segments) {
    const cited = cites(s.sources)
    content.push([s.text, s.sources])
    for (const field of check.fields) {
      const others = check.fields.filter((f) => f !== field).map((f) => f.label)
      const values = fieldValues(s.text, field.label, others)
      if (values.length > 1) repeated++
      else if (values[0] == null) missing++
      else if (!isPlaceholder(values[0], field.placeholder) && !cited) unsourced++
    }
  }
  return missing === 0 && unsourced === 0 && repeated === 0
    ? PASS
    : { ok: false, evaluable: true, content, detail: { missing, unsourced, repeated } }
}

/** Runs a check on the segments of a text slot; null for a check of another kind. */
export function runSegmentCheck(
  check: RecipeCheck,
  doc: InternalDocument,
  recipe: Recipe,
): SegmentCheckOutcome | null {
  if (check.kind === 'segments_cited') return segmentsCited(doc, recipe, check)
  if (check.kind === 'segment_fields') return segmentFields(doc, recipe, check)
  return null
}
