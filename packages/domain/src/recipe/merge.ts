import type { Nature } from '../answer.ts'
import { DomainError } from '../errors.ts'
import {
  type DataCategory,
  declarationHolds,
  mostRestrictiveOf,
  restrictionOf,
} from './categories.ts'
import {
  type DeliverableDocument,
  DOCUMENT_SCHEMA,
  type DocumentBlock,
  type DocumentSection,
  type DocumentSegment,
  type DocumentSkeleton,
  type DocumentSourceRef,
} from './document-model.ts'
import { canonicalJson } from './hash.ts'

/**
 * A source of a slot segment, as the code verified it: the place, its labels, its date and the
 * category of what it holds (set by the verifier from the source, never by the model).
 */
export interface SlotSource {
  ref: DocumentSourceRef
  /** The label of the internal version: the title of the source. */
  label: string
  /** The generic class of the source and nothing else, for the client version. */
  clientLabel?: string
  /** ISO instant, or null when the source does not date its data. */
  dataAsOf: string | null
  category: DataCategory
}

export interface SlotSegment {
  text: string
  nature: Nature
  /** The category the writer declared; raised to what the cited sources hold. */
  category: DataCategory
  sources: readonly SlotSource[]
}

/** The verified content of one text slot. */
export interface SlotContent {
  segments: readonly SlotSegment[]
  /** Notes for the PM only: refused in a client version. */
  internalNotes?: readonly SlotSegment[]
}

const length = (s: string) => [...s].length

/**
 * The category a segment is shown with. A text is not a computation: the declared category
 * stands only when it holds for every cited source taken alone; otherwise the segment is raised
 * to the most restrictive of the declared and the cited categories that holds for each of them.
 * When none does (an ordered and an invoiced amount cited together) it is shown as the first of
 * the most restrictive amounts: the client gate admits it by its `sourceCategories`, one by one.
 */
export function segmentCategory(
  declared: DataCategory,
  cited: readonly DataCategory[],
): DataCategory {
  if (cited.every((c) => declarationHolds(declared, c))) return declared
  const top = restrictionOf(mostRestrictiveOf([declared, ...cited]))
  const candidates = [declared, ...cited].filter((c) => restrictionOf(c) === top)
  return (
    candidates.find((c) => cited.every((x) => declarationHolds(c, x))) ??
    (candidates[0] as DataCategory)
  )
}

/**
 * The document made of a skeleton and the contents of its slots. Every slot becomes a text block
 * in its place; a slot without content is «non dedotto». The sources of the slots join the
 * numbered notes of the skeleton: a source already noted keeps its number, a new one takes the
 * next. In the client version a note is the generic class of the source and its date, without
 * the place. The skeleton itself (sections, tables, values, notes) is copied unchanged.
 *
 * Throws on a content for a slot the skeleton does not have, on a nature the slot does not
 * admit, on a text longer than the slot allows, on a client source without a generic label and
 * on internal notes in a client version.
 */
export function mergeDocument(
  skeleton: DocumentSkeleton,
  slots: Readonly<Record<string, SlotContent>>,
): DeliverableDocument {
  const client = skeleton.audience === 'client'
  const notes = skeleton.sourceNotes.map((n) => structuredClone(n))
  const byKey = new Map<string, number>()
  const keyOfNote = (label: string, dataAsOf: string | null, ref?: DocumentSourceRef) =>
    client ? canonicalJson({ label, dataAsOf }) : canonicalJson(ref)
  for (const n of notes) {
    byKey.set(keyOfNote(n.label, n.dataAsOf, 'ref' in n ? n.ref : undefined), n.n)
  }
  let next = notes.reduce((max, n) => Math.max(max, n.n), 0) + 1
  // The columns of a row of the warehouse are the skeleton's to say: a source that names columns
  // the skeleton did not cite that row with is worth the whole row.
  const skeletonRefs = new Set(notes.flatMap((n) => ('ref' in n ? [canonicalJson(n.ref)] : [])))
  const ownColumns = (ref: DocumentSourceRef): DocumentSourceRef =>
    ref.kind === 'system_row' && ref.columns !== undefined && !skeletonRefs.has(canonicalJson(ref))
      ? { ...ref, columns: undefined }
      : ref

  const noteOf = (s: SlotSource, slot: string): number => {
    if (client && s.clientLabel === undefined) {
      throw new DomainError('slot_source_without_client_label', { slot })
    }
    const label = client ? (s.clientLabel as string) : s.label
    const ref = ownColumns(s.ref)
    const key = keyOfNote(label, s.dataAsOf, ref)
    const known = byKey.get(key)
    if (known !== undefined) return known
    const n = next++
    notes.push(
      client ? { n, label, dataAsOf: s.dataAsOf } : { n, label, dataAsOf: s.dataAsOf, ref },
    )
    byKey.set(key, n)
    return n
  }
  const segmentOf = (s: SlotSegment, slot: string): DocumentSegment => {
    // One entry per cited note and category: a note of the client version can stand for
    // sources of different categories (two figures of the same system).
    const entries = new Map<string, [number, DataCategory]>()
    for (const x of s.sources) {
      const n = noteOf(x, slot)
      entries.set(`${n}:${x.category}`, [n, x.category])
    }
    const pairs = [...entries.values()]
    return {
      text: s.text,
      nature: s.nature,
      category: segmentCategory(
        s.category,
        pairs.map(([, c]) => c),
      ),
      sources: pairs.map(([n]) => n),
      sourceCategories: pairs.map(([, c]) => c),
    }
  }

  const slotIds = new Set<string>()
  for (const section of skeleton.sections) {
    for (const b of section.blocks) if (b.kind === 'slot') slotIds.add(b.id)
  }
  for (const id of Object.keys(slots)) {
    if (!slotIds.has(id)) throw new DomainError('slot_unknown', { slot: id })
  }

  const internalNotes: DocumentSegment[] = []
  const sections = skeleton.sections.map(
    (section): DocumentSection => ({
      id: section.id,
      title: section.title,
      version: section.version,
      notDeduced: section.notDeduced,
      blocks: section.blocks.map((b): DocumentBlock => {
        if (b.kind !== 'slot') return structuredClone(b)
        const content = Object.hasOwn(slots, b.id) ? slots[b.id] : undefined
        const segments = content?.segments ?? []
        for (const s of segments) {
          if (!b.natures.includes(s.nature)) {
            throw new DomainError('slot_nature_not_allowed', { slot: b.id })
          }
        }
        if (segments.reduce((n, s) => n + length(s.text), 0) > b.maxChars) {
          throw new DomainError('slot_too_long', { slot: b.id })
        }
        const notesOfSlot = content?.internalNotes ?? []
        if (client && notesOfSlot.length > 0) {
          throw new DomainError('client_internal_notes', { slot: b.id })
        }
        internalNotes.push(...notesOfSlot.map((s) => segmentOf(s, b.id)))
        return {
          kind: 'text',
          id: b.id,
          ...(b.title === undefined ? {} : { title: b.title }),
          segments: segments.map((s) => segmentOf(s, b.id)),
          notDeduced: segments.length === 0,
        }
      }),
    }),
  )

  const common = {
    schema: DOCUMENT_SCHEMA,
    recipe: { ...skeleton.recipe },
    lang: skeleton.lang,
    title: skeleton.title,
    header: { ...skeleton.header },
    sections,
  }
  if (client) {
    return {
      ...common,
      audience: 'client',
      sourceNotes: notes.map((n) => ({ n: n.n, label: n.label, dataAsOf: n.dataAsOf })),
      internalNotes: [],
    }
  }
  return {
    ...common,
    audience: 'internal',
    sourceNotes: notes.flatMap((n) => ('ref' in n ? [{ ...n, ref: n.ref }] : [])),
    internalNotes,
  }
}
