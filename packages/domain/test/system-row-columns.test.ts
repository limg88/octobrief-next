import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  type DocumentSourceRef,
  mergeDocument,
  projectClientVersion,
  type Recipe,
  type SlotContent,
  sourceRefCategories,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  blockIn,
  deliveryRecipe,
  draftOf,
  gatherDelivery,
  project,
  salParams,
} from './support/delivery-recipes.ts'

// A row of the data warehouse cited by a text is worth the columns the skeleton read from it,
// never every column of its view: an invoiced amount stays an invoiced amount. A row cited
// without its columns is worth every column of the view, and the writer cannot narrow them.

const p = project()

const invoiceRow = (columns?: string[]): DocumentSourceRef => ({
  kind: 'system_row',
  sourceId: 'src-dwsi',
  view: 'v_invoice_all',
  key: [{ column: 'invoiceid', value: 'FT-1' }],
  ...(columns === undefined ? {} : { columns }),
})

/** The SAL, with the text of the invoice item shown too when `withItem`. */
function sal(withItem = false): Recipe {
  return deliveryRecipe('sal-economico', (raw) => {
    if (!withItem) return
    const invoices = raw.sections.find((s) => s.id === 'invoices')?.blocks[0] as {
      columns: Array<Record<string, unknown>>
    }
    invoices.columns.push({
      id: 'item',
      title: 'Voce',
      from: { kind: 'field', field: 'item' },
      category: 'rates',
    })
  })
}

/** The skeleton note of the first invoice of the warehouse, as the writer is given it. */
function firstInvoiceNote(recipe: Recipe) {
  const gathered = gatherDelivery(recipe, p, salParams(p))
  const { skeleton, draft } = draftOf(recipe, gathered)
  const invoices = blockIn(draft, 'invoices')
  if (invoices.kind !== 'table') throw new Error('no invoices')
  const n = invoices.rows[0]?.cells[2]?.sources[0]
  const note = skeleton.sourceNotes.find((x) => x.n === n)
  if (!note || !('ref' in note)) throw new Error('no note')
  return { gathered, skeleton, note }
}

function mailCiting(ref: DocumentSourceRef, label: string, dataAsOf: string | null): SlotContent {
  return {
    segments: [
      {
        text: `La fattura ${p.invoices[0]?.number} è già stata emessa.`,
        nature: 'fact',
        category: 'invoiced_amounts',
        sources: [
          { ref, label, clientLabel: 'Sistema amministrativo', dataAsOf, category: 'other' },
        ],
      },
    ],
  }
}

const internalData = (recipe: Recipe, slots: Record<string, SlotContent>) => {
  const gathered = gatherDelivery(recipe, p, salParams(p))
  const { draft } = draftOf(recipe, gathered, slots)
  return projectClientVersion(draft, audienceOf(recipe, gathered)).report.anomalies.filter(
    (a) => a.code === 'internal_data_in_client',
  )
}

describe('a row of the data warehouse cited by a text', () => {
  it('is worth the columns cited, or every column of its view when none is', () => {
    const ctx = { evidence: {}, facts: {} }
    expect(sourceRefCategories(invoiceRow(['amount', 'invoicedate', 'invoiceid']), ctx)).toEqual([
      'invoiced_amounts',
      'other',
    ])
    expect(sourceRefCategories(invoiceRow(['amount', 'item']), ctx)).toEqual([
      'invoiced_amounts',
      'rates',
    ])
    expect(sourceRefCategories(invoiceRow(), ctx)).toEqual(['invoiced_amounts', 'rates', 'other'])
    // A column outside the map is worth the most restrictive category.
    expect(sourceRefCategories(invoiceRow(['memo']), ctx)).toEqual(['personal'])
  })

  it('is cited once, with the columns the recipe reads, whichever blocks read it', () => {
    const recipe = deliveryRecipe('sal-economico', (raw) => {
      raw.sections
        .find((s) => s.id === 'sources')
        ?.blocks.push({
          kind: 'data_table',
          id: 'invoice_dates',
          query: { kind: 'system_rows', view: 'v_invoice_all' },
          columns: [
            {
              id: 'number',
              title: 'Numero',
              from: { kind: 'field', field: 'invoiceid' },
              category: 'other',
            },
            {
              id: 'status',
              title: 'Stato',
              from: { kind: 'field', field: 'status' },
              category: 'other',
            },
          ],
        })
    })
    const { draft } = draftOf(recipe, gatherDelivery(recipe, p, salParams(p)))
    const rows = draft.sourceNotes.filter(
      (n) => 'ref' in n && (n.ref as DocumentSourceRef).kind === 'system_row',
    )
    expect(rows).toHaveLength(p.invoices.length)
    expect(rows[0] && 'ref' in rows[0] ? rows[0].ref : null).toMatchObject({
      columns: ['amount', 'invoicedate', 'invoiceid', 'status'],
    })
  })

  it('is cited by the skeleton with the columns its block reads', () => {
    const { note } = firstInvoiceNote(sal())
    expect(note.ref).toMatchObject({
      kind: 'system_row',
      view: 'v_invoice_all',
      columns: ['amount', 'invoicedate', 'invoiceid'],
    })
  })

  it('lets an invoiced amount of the warehouse into a text for the client', () => {
    const recipe = sal()
    const { note } = firstInvoiceNote(recipe)
    expect(
      internalData(recipe, { mail_text: mailCiting(note.ref, note.label, note.dataAsOf) }),
    ).toEqual([])
  })

  it('flags a text citing a row whose cited columns hold the text of the item', () => {
    const recipe = sal(true)
    const { note } = firstInvoiceNote(recipe)
    expect((note.ref as { columns?: string[] }).columns).toContain('item')
    expect(
      internalData(recipe, { mail_text: mailCiting(note.ref, note.label, note.dataAsOf) }),
    ).not.toEqual([])
  })

  it('never lets the writer narrow a row to columns the skeleton did not cite', () => {
    const recipe = sal()
    const { note, skeleton } = firstInvoiceNote(recipe)
    const narrowed = { ...note.ref, columns: ['amount'] } as DocumentSourceRef
    const doc = mergeDocument(skeleton, {
      mail_text: mailCiting(narrowed, note.label, note.dataAsOf),
    })
    const cited = doc.sourceNotes.filter(
      (n) =>
        'ref' in n &&
        (n.ref as DocumentSourceRef).kind === 'system_row' &&
        (n.ref as { columns?: unknown }).columns === undefined,
    )
    expect(cited).toHaveLength(1)
    // Whatever columns a text cites, the row is worth what the recipe reads from the view.
    expect(
      internalData(recipe, { mail_text: mailCiting(narrowed, note.label, note.dataAsOf) }),
    ).toEqual([])
    // The skeleton's own ref is kept as it is.
    const kept = mergeDocument(skeleton, {
      mail_text: mailCiting(note.ref, note.label, note.dataAsOf),
    })
    expect(
      kept.sourceNotes.filter(
        (n) => 'ref' in n && canonicalJson(n.ref as DocumentSourceRef) === canonicalJson(note.ref),
      ),
    ).toHaveLength(1)
  })

  it('judges a text by every column the recipe reads from the view, whichever block it cites', () => {
    // An internal block reads the text of the item of the same invoices: a text citing the
    // client table's row could quote it.
    const recipe = deliveryRecipe('sal-economico', (raw) => {
      const sources = raw.sections.find((s) => s.id === 'sources')
      sources?.blocks.push({
        kind: 'data_table',
        id: 'invoice_items',
        query: { kind: 'system_rows', view: 'v_invoice_all' },
        columns: [
          {
            id: 'number',
            title: 'Numero',
            from: { kind: 'field', field: 'invoiceid' },
            category: 'other',
          },
          { id: 'item', title: 'Voce', from: { kind: 'field', field: 'item' }, category: 'rates' },
        ],
      })
    })
    const { note } = firstInvoiceNote(recipe)
    // The row is cited with what the recipe reads from the view, so every block cites it alike.
    expect((note.ref as { columns?: string[] }).columns).toContain('item')
    expect(
      internalData(recipe, { mail_text: mailCiting(note.ref, note.label, note.dataAsOf) }),
    ).not.toEqual([])
    // A column nobody reads changes nothing: the default SAL mail stays clean.
    const plain = sal()
    const first = firstInvoiceNote(plain).note
    const forged = { ...first.ref, columns: ['annocompetenza'] } as DocumentSourceRef
    expect(
      internalData(plain, { mail_text: mailCiting(forged, first.label, first.dataAsOf) }),
    ).toEqual([])
  })
})
