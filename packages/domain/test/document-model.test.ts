import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DOCUMENT_JSON_SCHEMA,
  type DocumentSkeleton,
  DomainError,
  documentSchema,
  mergeDocument,
  type SlotContent,
  segmentCategory,
  skeletonSchema,
} from '../src/recipe/index.ts'

const SCHEMA_FILE = new URL('../schemas/octobrief.document-1.schema.json', import.meta.url)

function skeleton(): DocumentSkeleton {
  return {
    schema: 'octobrief.document/1',
    recipe: { slug: 'sal-economico', version: '1.0.0', title: 'SAL economico' },
    audience: 'internal',
    lang: 'it',
    title: 'SAL di ottobre',
    header: { dataAsOf: '2026-11-05T08:00:00.000Z', generatedAt: '2026-11-06T09:30:00.000Z' },
    sections: [
      {
        id: 'order',
        title: "Posizioni dell'ordine",
        version: 'both',
        notDeduced: false,
        blocks: [
          {
            kind: 'table',
            id: 'positions',
            title: 'Posizioni',
            columns: [
              { id: 'item', title: 'Voce', category: 'other' },
              { id: 'amount', title: 'Importo', category: 'contract_amounts' },
            ],
            rows: [
              {
                key: '1',
                cells: [
                  {
                    text: 'Analisi',
                    category: 'other',
                    operandCategories: ['other'],
                    sources: [1],
                  },
                  {
                    text: '12.000,00 €',
                    category: 'contract_amounts',
                    operandCategories: ['contract_amounts'],
                    sources: [1],
                  },
                ],
              },
              {
                key: '2',
                cells: [
                  {
                    text: 'Sviluppo',
                    category: 'other',
                    operandCategories: ['other'],
                    sources: [1],
                  },
                  {
                    text: null,
                    category: 'contract_amounts',
                    operandCategories: ['contract_amounts'],
                    sources: [],
                  },
                ],
              },
            ],
            notDeduced: false,
          },
          {
            kind: 'value',
            id: 'order_total',
            label: "Totale dell'ordine",
            cell: {
              text: '12.000,00 €',
              category: 'contract_amounts',
              operandCategories: ['contract_amounts'],
              sources: [1],
            },
          },
        ],
      },
      {
        id: 'summary',
        title: 'Sintesi',
        version: 'both',
        notDeduced: false,
        blocks: [
          { kind: 'static', id: 'intro', text: 'Di seguito lo stato della richiesta.' },
          { kind: 'slot', id: 'summary_text', natures: ['fact', 'inference'], maxChars: 200 },
          {
            kind: 'slot',
            id: 'next_steps',
            title: 'Prossimi passi',
            natures: ['suggestion'],
            maxChars: 200,
          },
        ],
      },
    ],
    sourceNotes: [
      {
        n: 1,
        label: 'Ordini del sistema amministrativo',
        dataAsOf: '2026-11-05T08:00:00.000Z',
        ref: {
          kind: 'system_row',
          sourceId: 'src-dwsi',
          view: 'v_sales_order_all',
          key: [
            { column: 'salesorderid', value: 'SO-1' },
            { column: 'lineid', value: '1' },
          ],
        },
      },
    ],
  }
}

function clientSkeleton(): DocumentSkeleton {
  const sk = skeleton()
  return {
    ...sk,
    audience: 'client',
    sourceNotes: [{ n: 1, label: 'Sistema amministrativo', dataAsOf: '2026-11-05T08:00:00.000Z' }],
  }
}

const slots: Record<string, SlotContent> = {
  summary_text: {
    segments: [
      {
        text: "L'ordine vale 12.000,00 €.",
        nature: 'fact',
        category: 'contract_amounts',
        sources: [
          {
            ref: {
              kind: 'system_row',
              sourceId: 'src-dwsi',
              view: 'v_sales_order_all',
              key: [
                { column: 'salesorderid', value: 'SO-1' },
                { column: 'lineid', value: '1' },
              ],
            },
            label: 'Ordini del sistema amministrativo',
            clientLabel: 'Sistema amministrativo',
            dataAsOf: '2026-11-05T08:00:00.000Z',
            category: 'contract_amounts',
          },
        ],
      },
      {
        text: 'Il verbale conferma la consegna.',
        nature: 'inference',
        category: 'other',
        sources: [
          {
            ref: { kind: 'evidence', evidenceId: 'ev-1', locator: { kind: 'page', page: 2 } },
            label: 'Verbale del 30 ottobre',
            clientLabel: 'Verbale di progetto',
            dataAsOf: '2026-10-30T00:00:00.000Z',
            category: 'other',
          },
        ],
      },
    ],
    internalNotes: [
      {
        text: 'Controllare la riga 2 con il cliente.',
        nature: 'suggestion',
        category: 'other',
        sources: [],
      },
    ],
  },
}

describe('document model', () => {
  it('merges skeleton and slots into a document that matches the exported schema', () => {
    const doc = mergeDocument(skeleton(), slots)
    expect(documentSchema.safeParse(doc).success).toBe(true)
    const fromJsonSchema = z.fromJSONSchema(DOCUMENT_JSON_SCHEMA as never)
    expect(fromJsonSchema.safeParse(doc).success).toBe(true)

    const summary = doc.sections[1]?.blocks
    expect(summary?.map((b) => b.kind)).toEqual(['static', 'text', 'text'])
    // The place already noted keeps its number; the new one takes the next.
    expect(summary?.[1]).toMatchObject({
      kind: 'text',
      id: 'summary_text',
      notDeduced: false,
      segments: [{ sources: [1] }, { sources: [2] }],
    })
    expect(doc.sourceNotes.map((n) => [n.n, n.label])).toEqual([
      [1, 'Ordini del sistema amministrativo'],
      [2, 'Verbale del 30 ottobre'],
    ])
    // A slot without content is «non dedotto», in its place.
    expect(summary?.[2]).toEqual({
      kind: 'text',
      id: 'next_steps',
      title: 'Prossimi passi',
      segments: [],
      notDeduced: true,
    })
    expect(doc.internalNotes.map((n) => n.text)).toEqual(['Controllare la riga 2 con il cliente.'])
    // The skeleton is copied unchanged.
    expect(doc.sections[0]).toEqual(skeleton().sections[0])
  })

  it('rejects a document the schema does not allow', () => {
    const doc = mergeDocument(skeleton(), slots)
    const fromJsonSchema = z.fromJSONSchema(DOCUMENT_JSON_SCHEMA as never)
    const bad = { ...doc, sections: [{ ...doc.sections[0], extra: true }] }
    expect(documentSchema.safeParse(bad).success).toBe(false)
    expect(fromJsonSchema.safeParse(bad).success).toBe(false)
    expect(documentSchema.safeParse({ ...doc, schema: 'octobrief.document/2' }).success).toBe(false)
  })

  it('validates its skeleton with its own schema', () => {
    expect(skeletonSchema.safeParse(skeleton()).success).toBe(true)
    expect(documentSchema.safeParse(skeleton()).success).toBe(false)
  })

  it('refuses a slot the skeleton does not have, a nature it does not admit, a text too long', () => {
    const one = (content: Partial<SlotContent['segments'][number]>): SlotContent => ({
      segments: [{ text: 'Testo.', nature: 'fact', category: 'other', sources: [], ...content }],
    })
    const codeOf = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e instanceof DomainError ? e.code : 'other'
      }
      return null
    }
    expect(codeOf(() => mergeDocument(skeleton(), { ghost: one({}) }))).toBe('slot_unknown')
    expect(codeOf(() => mergeDocument(skeleton(), { next_steps: one({}) }))).toBe(
      'slot_nature_not_allowed',
    )
    expect(
      codeOf(() => mergeDocument(skeleton(), { summary_text: one({ text: 'x'.repeat(201) }) })),
    ).toBe('slot_too_long')
  })

  it('rejects a segment without one category per cited source', () => {
    const doc = mergeDocument(skeleton(), slots)
    const withSegment = (segment: Record<string, unknown>) => ({
      ...doc,
      sections: [
        {
          ...doc.sections[0],
          blocks: [{ kind: 'text', id: 't', segments: [segment], notDeduced: false }],
        },
      ],
    })
    const base = { text: 'Testo.', nature: 'fact', category: 'other' }
    expect(
      documentSchema.safeParse(withSegment({ ...base, sources: [1], sourceCategories: [] }))
        .success,
    ).toBe(false)
    expect(
      documentSchema.safeParse(withSegment({ ...base, sources: [], sourceCategories: ['other'] }))
        .success,
    ).toBe(false)
    expect(
      documentSchema.safeParse(withSegment({ ...base, sources: [1], sourceCategories: ['other'] }))
        .success,
    ).toBe(true)
  })

  it('keeps the category of each cited source on a segment, so each can be admitted alone', () => {
    const ordered = slots.summary_text?.segments[0]?.sources[0]
    if (!ordered) throw new Error()
    const invoiced = {
      ...ordered,
      ref: { kind: 'fact' as const, factId: 'f-invoiced' },
      label: 'Fatturato',
      category: 'invoiced_amounts' as const,
    }
    const doc = mergeDocument(skeleton(), {
      summary_text: {
        segments: [
          {
            text: 'Ordinato e fatturato.',
            nature: 'fact',
            category: 'other',
            sources: [ordered, invoiced],
          },
        ],
      },
    })
    const text = doc.sections[1]?.blocks[1]
    if (text?.kind !== 'text') throw new Error()
    expect(text.segments[0]).toMatchObject({
      category: 'contract_amounts',
      sources: [1, 2],
      sourceCategories: ['contract_amounts', 'invoiced_amounts'],
    })
    expect(documentSchema.safeParse(doc).success).toBe(true)
  })

  it('treats a text as no computation: one source of each category decides', () => {
    // An ordered amount cited as invoiced is shown as ordered; a cost raises the segment.
    expect(segmentCategory('invoiced_amounts', ['contract_amounts'])).toBe('contract_amounts')
    expect(segmentCategory('other', ['costs', 'invoiced_amounts'])).toBe('costs')
    expect(segmentCategory('contract_amounts', ['contract_amounts', 'other'])).toBe(
      'contract_amounts',
    )
    expect(segmentCategory('other', ['other'])).toBe('other')
    expect(segmentCategory('other', [])).toBe('other')
    expect(segmentCategory('other', ['invoiced_amounts', 'contract_amounts'])).toBe(
      'invoiced_amounts',
    )
  })

  it('raises a segment to the category its sources hold, whatever the writer declared', () => {
    const source = slots.summary_text?.segments[0]?.sources[0]
    if (!source) throw new Error()
    const doc = mergeDocument(skeleton(), {
      summary_text: {
        segments: [
          {
            text: 'Il valore è quello del sistema.',
            nature: 'fact',
            category: 'other',
            sources: [source],
          },
        ],
      },
    })
    const text = doc.sections[1]?.blocks[1]
    expect(text?.kind === 'text' ? text.segments[0]?.category : null).toBe('contract_amounts')
  })

  it('copies the skeleton: changing the document never changes it', () => {
    const sk = skeleton()
    const doc = mergeDocument(sk, slots)
    const table = doc.sections[0]?.blocks[0]
    if (table?.kind !== 'table') throw new Error()
    table.rows.pop()
    expect(sk).toEqual(skeleton())
  })

  it('accepts the operand categories of a computed value', () => {
    const sk = skeleton()
    const value = sk.sections[0]?.blocks[1]
    if (value?.kind !== 'value') throw new Error()
    value.cell.operandCategories = ['contract_amounts', 'invoiced_amounts']
    expect(documentSchema.safeParse(mergeDocument(sk, slots)).success).toBe(true)
  })

  it('writes generic source notes without places, and no internal notes, for the client', () => {
    const doc = mergeDocument(clientSkeleton(), {
      summary_text: { segments: slots.summary_text?.segments ?? [] },
    })
    expect(doc.audience).toBe('client')
    expect(doc.sourceNotes).toEqual([
      { n: 1, label: 'Sistema amministrativo', dataAsOf: '2026-11-05T08:00:00.000Z' },
      { n: 2, label: 'Verbale di progetto', dataAsOf: '2026-10-30T00:00:00.000Z' },
    ])
    expect(doc.internalNotes).toEqual([])
    const fromJsonSchema = z.fromJSONSchema(DOCUMENT_JSON_SCHEMA as never)
    expect(documentSchema.safeParse(doc).success).toBe(true)
    expect(fromJsonSchema.safeParse(doc).success).toBe(true)
    // A place or an internal note in a client document is refused by both schemas.
    const withRef = {
      ...doc,
      sourceNotes: [{ ...doc.sourceNotes[0], ref: { kind: 'fact', factId: 'f' } }],
    }
    const withNotes = {
      ...doc,
      internalNotes: [
        { text: 'x', nature: 'fact', category: 'other', sources: [], sourceCategories: [] },
      ],
    }
    for (const bad of [withRef, withNotes]) {
      expect(documentSchema.safeParse(bad).success).toBe(false)
      expect(fromJsonSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('refuses a client source without a generic label and internal notes in a client version', () => {
    const codeOf = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return e instanceof DomainError ? e.code : 'other'
      }
      return null
    }
    const segment = slots.summary_text?.segments[1]
    const source = segment?.sources[0]
    if (!segment || !source) throw new Error()
    const { clientLabel: _, ...unlabelled } = source
    expect(
      codeOf(() =>
        mergeDocument(clientSkeleton(), {
          summary_text: { segments: [{ ...segment, sources: [unlabelled] }] },
        }),
      ),
    ).toBe('slot_source_without_client_label')
    expect(codeOf(() => mergeDocument(clientSkeleton(), slots))).toBe('client_internal_notes')
  })

  it('keeps the exported JSON Schema in the file the renderer reads', () => {
    const onDisk = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
    expect(onDisk).toEqual(DOCUMENT_JSON_SCHEMA)
  })
})
