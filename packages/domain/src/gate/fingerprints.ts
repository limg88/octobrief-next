import { canonicalText } from '../canonical.ts'
import { type Lang, vocabulary } from '../language/index.ts'
import { claimedNumbersIn } from '../numbers.ts'
import type { ContentHash } from '../pseudonym.ts'
import type {
  DeliverableDocument,
  DocumentBlock,
  DocumentSegment,
  DocumentSkeleton,
  SkeletonSlot,
  SourceNote,
} from '../recipe/document-model.ts'
import { canonicalHash, canonicalJson } from '../recipe/hash.ts'

// The fingerprints of a draft, the guard of the automatic cycle:
// - `skeletonHash`: the canonical fingerprint of the skeleton (sections, tables, values, totals and
//   their sources), the same for a skeleton and for any draft merged from it, whatever its slots;
// - `dataHash`: the values of the skeleton plus the ordered set of the pairs (number, date or
//   name; source) the slots state with a citation. A rewrite that only changes the wording keeps
//   it; one that changes, adds or drops a cited datum, or cites it to another source, does not.
// Sources are compared by the place they cite, never by their number in the notes.

type Draftish = DeliverableDocument | DocumentSkeleton

/** What a note stands for: the place it cites, or its generic label and date in a client version. */
function noteKey(note: SourceNote): string {
  return 'ref' in note
    ? canonicalJson(note.ref)
    : canonicalJson({ label: note.label, dataAsOf: note.dataAsOf })
}

function resolver(d: Draftish): (ns: readonly number[]) => string[] {
  const keys = new Map(d.sourceNotes.map((n) => [n.n, noteKey(n)]))
  return (ns) => [...new Set(ns.map((n) => keys.get(n) ?? `missing:${n}`))].sort()
}

function isSlotLike(
  b: DocumentBlock | SkeletonSlot,
): b is SkeletonSlot | Extract<DocumentBlock, { kind: 'text' }> {
  return b.kind === 'slot' || b.kind === 'text'
}

function skeletonView(d: Draftish) {
  const sources = resolver(d)
  const cell = (c: {
    text: string | null
    category: string
    operandCategories: readonly string[]
    sources: readonly number[]
  }) => ({
    text: c.text,
    category: c.category,
    operandCategories: c.operandCategories,
    sources: sources(c.sources),
  })
  return {
    schema: d.schema,
    recipe: d.recipe,
    audience: d.audience,
    lang: d.lang,
    title: d.title,
    dataAsOf: d.header.dataAsOf,
    sections: d.sections.map((s) => ({
      id: s.id,
      title: s.title,
      version: s.version,
      notDeduced: s.notDeduced,
      blocks: (s.blocks as ReadonlyArray<DocumentBlock | SkeletonSlot>).map((b) => {
        if (isSlotLike(b)) return { kind: 'slot', id: b.id, title: b.title }
        if (b.kind === 'value') {
          return { kind: b.kind, id: b.id, label: b.label, cell: cell(b.cell) }
        }
        if (b.kind === 'static') return b
        const rows = b.kind === 'table' ? b.rows : b.items
        return {
          kind: b.kind,
          id: b.id,
          title: b.title,
          columns: b.columns,
          notDeduced: b.notDeduced,
          rows: rows.map((r) => ({ key: r.key, cells: r.cells.map(cell) })),
        }
      }),
    })),
  }
}

/** The fingerprint of the skeleton of a draft, or of the skeleton itself. */
export function skeletonHash(d: Draftish): ContentHash {
  return canonicalHash(skeletonView(d))
}

/** The values of the skeleton: every cell and value, where it is, and the places it cites. */
function skeletonValues(d: Draftish) {
  const sources = resolver(d)
  const out: unknown[] = []
  for (const s of d.sections) {
    for (const b of s.blocks as ReadonlyArray<DocumentBlock | SkeletonSlot>) {
      if (b.kind === 'value')
        out.push([s.id, b.id, null, null, b.cell.text, sources(b.cell.sources)])
      if (b.kind === 'table' || b.kind === 'list') {
        const rows = b.kind === 'table' ? b.rows : b.items
        for (const r of rows) {
          r.cells.forEach((c, i) => {
            out.push([s.id, b.id, r.key, b.columns[i]?.id ?? null, c.text, sources(c.sources)])
          })
        }
      }
    }
  }
  return out
}

/** Folded for comparison: canonical, lowercase, without accents. */
const fold = (text: string) =>
  canonicalText(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')

/**
 * The data a text states, each once: its claimed numbers, the months it names, the identifiers
 * it writes and the known names it mentions.
 */
export function statedData(text: string, lang: Lang, knownNames: readonly string[]): string[] {
  const vocab = vocabulary(lang)
  const out = new Set<string>()
  for (const n of claimedNumbersIn(text, lang)) out.add(`number:${n}`)
  const words = new Set(fold(text).split(/[^\p{L}\p{N}]+/u))
  for (const m of vocab.FULL_MONTHS) if (words.has(m)) out.add(`month:${m}`)
  const plain = canonicalText(text)
  for (const re of vocab.IDENTIFIERS) {
    for (const [m] of plain.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      out.add(`id:${m.toLowerCase()}`)
    }
  }
  const spaced = ` ${fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  for (const name of knownNames) {
    const n = fold(name)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
    if (n !== '' && spaced.includes(` ${n} `)) out.add(`name:${n}`)
  }
  return [...out]
}

/** The pairs (datum, source) the cited segments of the slots state, sorted and each once. */
export function slotDataPairs(
  doc: DeliverableDocument,
  lang: Lang,
  knownNames: readonly string[],
): Array<[string, string]> {
  const sources = resolver(doc)
  const pairs = new Set<string>()
  const add = (seg: DocumentSegment) => {
    if (seg.sources.length === 0) return
    const cited = sources(seg.sources)
    for (const datum of statedData(seg.text, lang, knownNames)) {
      for (const source of cited) pairs.add(canonicalJson([datum, source]))
    }
  }
  for (const s of doc.sections) {
    for (const b of s.blocks) if (b.kind === 'text') b.segments.forEach(add)
  }
  doc.internalNotes.forEach(add)
  return [...pairs].sort().map((p) => JSON.parse(p) as [string, string])
}

/** The fingerprint of the data of a draft: the values of its skeleton and the cited data of its slots. */
export function dataHash(
  doc: DeliverableDocument,
  lang: Lang,
  knownNames: readonly string[],
): ContentHash {
  return canonicalHash({ values: skeletonValues(doc), pairs: slotDataPairs(doc, lang, knownNames) })
}
