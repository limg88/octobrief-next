import { describe, expect, it } from 'vitest'
import {
  buildSkeleton,
  createReadLog,
  type DocumentSkeleton,
  DomainError,
  documentRefOf,
  type EvidenceId,
  mergeDocument,
  parseSlotAnswer,
  pmRequestSlots,
  portableSchema,
  SLOT_LIMITS,
  shownDraft,
  skeletonForWriter,
  skeletonNoteFactId,
  skeletonNoteOf,
  skeletonOfRevision,
  slotAnswerSchema,
  slotContentOf,
  suspendedNotes,
  verifyAnswer,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { orderNoteRef, orderRef, REFERENCE_TIME, sampleGathered } from './support/gathered.ts'
import {
  cleanDraft,
  redTeam,
  redTeamContext,
  summaryText,
  verifiedSlots,
} from './support/red-team.ts'

const SLOT = { natures: ['fact', 'inference'] as const, maxChars: 200 }

const answer = (over: Record<string, unknown> = {}) => ({
  lang: 'it',
  segments: [{ text: 'Il periodo è andato bene.', nature: 'inference', sources: [] }],
  absences: [],
  internalNotes: [],
  ...over,
})

function skeleton(): DocumentSkeleton {
  return buildSkeleton(recipeOf(), sampleGathered()).skeleton
}

describe('slot answer', () => {
  it('sends a portable schema', () => {
    expect(portableSchema(slotAnswerSchema)).toEqual(slotAnswerSchema)
  })

  it('reads a note of the skeleton as a citation the verifier knows', () => {
    const r = parseSlotAnswer(
      answer({
        segments: [{ text: 'Ordinati 12.000,00 €.', nature: 'fact', sources: [{ note: 1 }] }],
      }),
      SLOT,
    )
    expect(r.ok && r.slot.answer.segments[0]?.sources).toEqual([{ factId: skeletonNoteFactId(1) }])
    expect(skeletonNoteOf(skeletonNoteFactId(7))).toBe(7)
    expect(skeletonNoteOf('6f1c0a52-0000-4000-8000-000000000000')).toBeNull()
  })

  it('holds the answer to the slot: natures, length, counts and closed keys', () => {
    const bad = (raw: unknown) => {
      const r = parseSlotAnswer(raw, SLOT)
      return r.ok ? null : r.error
    }
    expect(
      bad(
        answer({
          segments: [{ text: 'Consiglio di rinviare.', nature: 'suggestion', sources: [] }],
        }),
      ),
    ).toEqual({ path: 'segments.0.nature', problem: 'invalid' })
    expect(
      bad(answer({ segments: [{ text: 'a'.repeat(201), nature: 'inference', sources: [] }] })),
    ).toEqual({ path: 'segments', problem: 'too_long' })
    const many = Array.from({ length: SLOT_LIMITS.segmentsMax + 1 }, () => ({
      text: 'x',
      nature: 'inference',
      sources: [],
    }))
    expect(bad(answer({ segments: many }))?.problem).toBe('too_many')
    expect(bad(answer({ other_slot: [] }))).toEqual({ path: 'other_slot', problem: 'invalid' })
    expect(
      bad(answer({ segments: [{ text: 'x', nature: 'fact', sources: [{ note: 0 }] }] }))?.path,
    ).toMatch(/^segments\.0\.sources/)
    expect(bad(answer({ internalNotes: [{ text: '', nature: 'fact', sources: [] }] }))?.path).toBe(
      'internalNotes.0.text',
    )
  })

  it('shows the writer the numbers of each note and nothing it may change', () => {
    const s = skeleton()
    const { context, reads } = skeletonForWriter(s, 'it')
    const first = reads.find((r) => r.n === 1)
    expect(first?.ref).toEqual(orderNoteRef('1'))
    expect(first?.numbers).toContain('12000')
    expect(JSON.stringify(context)).toContain('testo_da_scrivere')
  })

  it('shows the writer only the notes its shown rows and values cite', () => {
    const s = structuredClone(skeleton())
    const table = s.sections
      .flatMap((x) => x.blocks)
      .find((b): b is Extract<typeof b, { kind: 'table' }> => b.kind === 'table')
    if (!table) throw new Error('no table')
    // A tracker of 600 work items: one note each, 300 rows citing the first 300.
    const base = 1000
    const template = table.rows[0]
    if (!template) throw new Error('no row')
    s.sourceNotes.push(
      ...Array.from({ length: 600 }, (_, i) => ({
        n: base + i,
        label: `Elemento ${i}`,
        dataAsOf: REFERENCE_TIME,
        ref: orderNoteRef(String(base + i)),
      })),
    )
    table.rows = Array.from({ length: 300 }, (_, i) => ({
      key: `k${i}`,
      cells: template.cells.map((c) => ({ ...c, sources: [base + i] })),
    }))
    const { context } = skeletonForWriter(s, 'it')
    const shown = (context as { note: Array<{ n: number }>; note_non_mostrate: number }).note
    const ns = new Set(shown.map((x) => x.n))
    // Every note of a shown row is there.
    for (let i = 0; i < SLOT_LIMITS.rowsShown; i++) expect(ns.has(base + i)).toBe(true)
    // No note of a row past the limit, nor of a work item no shown row cites.
    for (let i = SLOT_LIMITS.rowsShown; i < 600; i++) expect(ns.has(base + i)).toBe(false)
    expect((context as { note_non_mostrate: number }).note_non_mostrate).toBe(
      s.sourceNotes.length - shown.length,
    )
    expect(shown.length).toBeLessThan(s.sourceNotes.length)
  })

  it('turns a number that differs from the skeleton into a text without source', () => {
    const s = skeleton()
    const { reads } = skeletonForWriter(s, 'it')
    const log = createReadLog()
    for (const r of reads) log.recordFact(skeletonNoteFactId(r.n), r.numbers)
    const registry = {
      evidence: () => null,
      tracker: () => null,
      fact: (id: string) => {
        const n = skeletonNoteOf(id)
        const read = reads.find((r) => r.n === n)
        return read
          ? {
              title: read.label,
              sourceDate: read.dataAsOf ? new Date(read.dataAsOf) : null,
              dateSource: 'system' as const,
              freshnessPolicy: 'system' as const,
              superseded: false,
              pmAsserted: false,
              contested: false,
            }
          : null
      },
    }
    const parsed = parseSlotAnswer(
      answer({
        segments: [
          { text: 'La riga 1 vale 12.000,00 €.', nature: 'fact', sources: [{ note: 1 }] },
          { text: 'La riga 1 vale 13.000,00 €.', nature: 'fact', sources: [{ note: 1 }] },
        ],
      }),
      SLOT,
    )
    if (!parsed.ok) throw new Error('not parsed')
    const verified = verifyAnswer(parsed.slot.answer, {
      lang: 'it',
      read: log.snapshot(),
      registry,
      thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
      now: new Date(REFERENCE_TIME),
      knownNames: [],
    })
    expect(verified.segments.map((x) => x.withoutSource)).toEqual([false, true])
    const content = slotContentOf(
      verified,
      verifyAnswer(parsed.slot.internalNotes, {
        lang: 'it',
        read: log.snapshot(),
        registry,
        thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
        now: new Date(REFERENCE_TIME),
        knownNames: [],
      }),
      { skeletonNotes: reads, audience: { evidence: {}, facts: {} } },
    )
    expect(content.segments[0]?.sources.map((x) => x.ref)).toEqual([orderNoteRef('1')])
    // The unverified source is not carried into the draft.
    expect(content.segments[1]?.sources).toEqual([])
  })

  it('maps the citations of the tools to places of the draft', () => {
    const notes = new Map([[3, orderRef('2')]])
    expect(documentRefOf({ factId: skeletonNoteFactId(3) }, notes)).toEqual(orderRef('2'))
    expect(documentRefOf({ factId: skeletonNoteFactId(9) }, notes)).toBeNull()
    expect(
      documentRefOf(
        { evidenceId: 'e1' as EvidenceId, locator: { kind: 'line', from: 1, to: 2 } },
        notes,
      ),
    ).toEqual({ kind: 'evidence', evidenceId: 'e1', locator: { kind: 'line', from: 1, to: 2 } })
  })
})

describe('gate 1 on the sources of a slot', () => {
  it('finds no source for a segment citing a note none of its verified sources stands for', () => {
    const doc = cleanDraft()
    const slots = verifiedSlots(doc)
    const seg = summaryText(doc).segments.at(-1)
    if (!seg) throw new Error('no segment')
    // The verifier saw the text with another note than the one the draft cites.
    const verified = slots.summary_text
    if (!verified) throw new Error('no verification')
    const last = verified.segments.at(-1)
    if (!last) throw new Error('no verified segment')
    last.sources = last.sources.map((s) => ({ ...s, ref: { factId: skeletonNoteFactId(99) } }))
    const r = redTeam(doc, redTeamContext({ slotVerifications: slots }))
    expect(r.anomalies.filter((a) => a.code === 'without_source')).toHaveLength(1)
    expect(redTeam(doc, redTeamContext()).anomalies).toEqual([])
  })
})

describe('revisions of a draft', () => {
  it('rewrites only text slots on a request of the PM and refuses the skeleton', () => {
    const doc = cleanDraft()
    const recipe = recipeOf()
    expect(pmRequestSlots(doc, recipe, ['summary_text'])).toEqual(['summary_text'])
    for (const targets of [['positions'], ['summary'], ['summary_text', 'intro'], []]) {
      expect(() => pmRequestSlots(doc, recipe, targets)).toThrow(DomainError)
    }
  })

  it('opens again only the planned slots, everything else as it was', () => {
    const doc = cleanDraft()
    const skeleton = skeletonOfRevision(doc, recipeOf(), ['summary_text'])
    const merged = mergeDocument(skeleton, {})
    expect(summaryText(merged as typeof doc).segments).toEqual([])
    expect(merged.sourceNotes).toEqual(doc.sourceNotes)
    expect(merged.header).toEqual(doc.header)
    const kept = mergeDocument(skeletonOfRevision(doc, recipeOf(), []), {})
    expect({ ...kept, internalNotes: doc.internalNotes }).toEqual(doc)
  })

  it('suspends the figures citing a stale source while its anomaly is open', () => {
    const doc = cleanDraft()
    const rows = [
      {
        code: 'stale_source',
        class: 'data',
        outcome: 'anomaly' as const,
        acceptable: true,
        ref: 'r',
        contentHash: 'h',
        detail: { notes: [1] },
      },
    ]
    const notes = suspendedNotes(rows, [], [])
    expect(notes).toEqual([1])
    const shown = shownDraft(doc, notes, 'it')
    const cells = shown.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.kind === 'table' ? b.rows.flatMap((r) => r.cells) : [])),
    )
    expect(cells.filter((c) => c.sources.includes(1)).every((c) => c.text === null)).toBe(true)
    expect(cells.some((c) => !c.sources.includes(1) && c.text !== null)).toBe(true)
    const accepted = suspendedNotes(
      rows,
      [
        {
          code: 'stale_source',
          refKey: 'r',
          contentHash: 'h',
          reason: 'Verificato a voce con il referente del cliente.',
          by: 'pm',
          at: '',
        },
      ],
      [],
    )
    expect(accepted).toEqual([])
  })
})
