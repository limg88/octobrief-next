import { describe, expect, it } from 'vitest'
import {
  checkParameterValues,
  type DeclaredValue,
  DomainError,
  declaredCellId,
  type InternalDocument,
  projectClientVersion,
  type Recipe,
  runRecipeChecks,
  type SlotContent,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  blockIn,
  cellsOf,
  deliveryRecipe,
  draftOf,
  EVIDENCE,
  gatherDelivery,
  project,
  SAL_CURRENT_2,
  SAL_PERIOD,
  type SalOver,
  salParams,
  salPositions,
  salRequestAmount,
  valueText,
} from './support/delivery-recipes.ts'

// The SAL economico of the library on the synthetic delivery project: the third request of the
// order, which brings the second position forward. Every check fails on its own synthetic case.

const p = project()
const PERIOD = SAL_PERIOD
const PREVIOUS_PERIOD = '2026-06-01..2026-09-30'
const last = p.issuedRequests.at(-1) as (typeof p.issuedRequests)[number]
const CURRENT_2 = SAL_CURRENT_2
const REQUEST_AMOUNT = salRequestAmount(p)
const positionsRows = () => salPositions(p)
const params = (over: SalOver = {}) => salParams(p, over)
type Over = SalOver

function run(over: Over = {}, recipe: Recipe = deliveryRecipe('sal-economico'), slots = {}) {
  const gathered = gatherDelivery(recipe, p, params(over))
  return { recipe, gathered, ...draftOf(recipe, gathered, slots) }
}

/** The values the approval of the second request declared to the client. */
function declaredSecondRequest(draft: InternalDocument): DeclaredValue[] {
  const out: DeclaredValue[] = []
  const declared = (sectionId: string, cellId: string, value: string): DeclaredValue => ({
    recipeSlug: 'sal-economico',
    sectionId,
    cellId,
    period: PREVIOUS_PERIOD,
    value,
    declaredAt: '2026-10-01T09:00:00.000Z',
  })
  out.push(declared('requests', declaredCellId('requests', 'number', '["2"]'), '2'))
  const progress = blockIn(draft, 'progress')
  if (progress.kind !== 'table') throw new Error('no progress')
  for (const row of progress.rows) {
    const position = row.cells[0]?.text as string
    out.push(
      declared(
        'progress',
        declaredCellId('progress', 'current_pct', row.key),
        String(last.progress[Number(position)] ?? 0),
      ),
    )
  }
  return out
}

function checks(
  recipe: Recipe,
  draft: InternalDocument,
  declaredValues: DeclaredValue[] = declaredSecondRequest(draft),
) {
  return runRecipeChecks(draft, {
    recipe,
    lang: 'it',
    parameters: { period: 'ottobre 2026' },
    periods: { period: { from: PERIOD.from, to: PERIOD.to } },
    declaredValues,
  })
}

const failing = (recipe: Recipe, draft: InternalDocument, declared?: DeclaredValue[]) =>
  checks(recipe, draft, declared).anomalies.map((a) => (a.ref as { check: string }).check)

describe('the SAL economico recipe', () => {
  it('is a valid recipe for the client, with the sections of the SAL in order', () => {
    const recipe = deliveryRecipe('sal-economico')
    expect(recipe.audience).toBe('client')
    expect(recipe.sections.map((s) => s.id)).toEqual([
      'order',
      'positions',
      'requests',
      'invoices',
      'progress',
      'mail',
      'sources',
    ])
    expect(recipe.render.formats).toEqual(['md', 'xlsx'])
  })

  it('builds the expected skeleton from the order, the requests and the warehouse', () => {
    const { draft } = run()
    expect(valueText(draft, 'order_number')).toBe(p.order.number)
    expect(cellsOf(draft, 'positions').map((r) => r[0])).toEqual(['1', '2', '3'])
    expect(valueText(draft, 'positions_total')).toBe(valueText(draft, 'order_total'))
    expect(cellsOf(draft, 'requests')).toEqual([
      [String(p.truth.nextNumber), expect.stringMatching(/,\d\d$/)],
    ])
    // Invoiced: the rows of the warehouse for this order, ordered and invoiced only.
    expect(cellsOf(draft, 'invoices').map((r) => r[0])).toEqual(p.invoices.map((i) => i.number))
    const invoiced =
      p.invoices.reduce((s, i) => s + i.amount, 0) +
      (p.truth.invoiceContradiction.dwsiAmount - p.truth.invoiceContradiction.documentAmount)
    const money = (n: number) =>
      new Intl.NumberFormat('it-IT', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: 'always',
      }).format(n)
    expect(valueText(draft, 'invoiced_total')).toBe(money(invoiced))
    expect(valueText(draft, 'residual')).toBe(money(p.order.total - invoiced))
    expect(valueText(draft, 'remaining_after')).toBe(
      money(p.order.total - invoiced - REQUEST_AMOUNT),
    )
    // The percent of the period is computed by the code: current minus previous.
    const second = cellsOf(draft, 'progress')[1] as string[]
    expect(Number(second[4])).toBe(CURRENT_2 - (last.progress[2] ?? 0))
  })

  it('never lets the model extract the order lines: they are the PM table, cited as such', () => {
    const { skeleton, draft } = run()
    const positions = blockIn(draft, 'positions')
    if (positions.kind !== 'table') throw new Error('no positions')
    const cited = new Set(positions.rows.flatMap((r) => r.cells.flatMap((c) => c.sources)))
    for (const n of cited) {
      const note = draft.sourceNotes.find((x) => x.n === n)
      expect(note && 'ref' in note ? note.ref : null).toEqual({
        kind: 'parameter',
        parameterId: 'positions',
        evidenceIds: [EVIDENCE.order],
      })
    }
    // The document chosen with them is cited in the internal part, never read into a table.
    expect(cellsOf(draft, 'order_documents')[0]?.[0]).toBe(p.documents[0]?.fileName)
    expect(skeleton.sections.flatMap((s) => s.blocks).some((b) => b.kind === 'slot')).toBe(true)
    // A slot cannot add a line: whatever the writer says, the table is the skeleton's.
    const slots: Record<string, SlotContent> = {
      mail_text: {
        segments: [
          {
            text: 'In allegato la richiesta.',
            nature: 'fact',
            category: 'other',
            sources: [],
          },
        ],
      },
    }
    const written = run({}, deliveryRecipe('sal-economico'), slots).draft
    expect(blockIn(written, 'positions')).toEqual(positions)
  })

  it('shows invoiced amounts and flags a rate', () => {
    // A recipe edited to show the text of the invoice item: the text may carry rates.
    const withItem = (category: string) =>
      deliveryRecipe('sal-economico', (raw) => {
        const invoices = raw.sections.find((s) => s.id === 'invoices')?.blocks[0] as {
          columns: Array<Record<string, unknown>>
        }
        invoices.columns.push({
          id: 'item',
          title: 'Voce',
          from: { kind: 'field', field: 'item' },
          category,
        })
      })
    expect(() => withItem('other')).toThrow(/column_category_looser/)
    const recipe = withItem('rates')
    const { gathered, draft } = run({}, recipe)
    const { version, report } = projectClientVersion(draft, audienceOf(recipe, gathered))
    const invoices = blockIn(version.document, 'invoices')
    if (invoices.kind !== 'table') throw new Error('no invoices')
    expect(invoices.columns.map((c) => c.id)).toEqual(['number', 'date', 'amount'])
    expect(invoices.rows[0]?.cells[2]?.text).toBe(cellsOf(draft, 'invoices')[0]?.[2])
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({
        code: 'internal_data_in_client',
        ref: expect.objectContaining({ element: 'column', block: 'invoices', column: 'item' }),
      }),
    )
  })

  it('flags a rate the writer takes from an internal document into the mail', () => {
    const recipe = deliveryRecipe('sal-economico')
    const team = p.documents[4]
    if (!team) throw new Error('no team document')
    const slots: Record<string, SlotContent> = {
      mail_text: {
        segments: [
          {
            text: "Tariffa oraria media: 45 € all'ora.",
            nature: 'fact',
            category: 'other',
            sources: [
              {
                ref: {
                  kind: 'evidence',
                  evidenceId: EVIDENCE.team,
                  locator: { kind: 'paragraph', index: 5 },
                },
                label: team.fileName,
                clientLabel: 'Documento di progetto',
                dataAsOf: '2026-11-01T00:00:00.000Z',
                category: 'personal',
              },
            ],
          },
        ],
      },
    }
    const { gathered, draft } = run({}, recipe, slots)
    const { version, report } = projectClientVersion(draft, audienceOf(recipe, gathered))
    expect(JSON.stringify(version.document)).not.toContain('45 €')
    expect(report.anomalies).toContainEqual(
      expect.objectContaining({ code: 'internal_data_in_client' }),
    )
  })

  it('passes every check but the seeded disagreement on an invoice', () => {
    const { recipe, draft } = run()
    expect(failing(recipe, draft)).toEqual(['invoices_agree'])
  })

  it('shows the two amounts of an invoice the sources disagree on, and never picks one', () => {
    const { recipe, draft } = run()
    const [a] = checks(recipe, draft).anomalies
    expect(a).toMatchObject({
      code: 'recipe_check_failed',
      class: 'data',
      resolution: 'acceptance',
      detail: { kind: 'agree_by_key', disagreements: 1 },
    })
    const { documentAmount, dwsiAmount, invoiceNumber } = p.truth.invoiceContradiction
    const inDocument = cellsOf(draft, 'cited_invoices').find((r) => r[0] === invoiceNumber)
    const inWarehouse = cellsOf(draft, 'invoices').find((r) => r[0] === invoiceNumber)
    expect(inDocument?.[2]).not.toBe(inWarehouse?.[2])
    expect(Number(inDocument?.[2]?.replace(/\./g, '').replace(',', '.'))).toBe(documentAmount)
    expect(Number(inWarehouse?.[2]?.replace(/\./g, '').replace(',', '.'))).toBe(dwsiAmount)
    // Citing the warehouse amount for it settles nothing in the draft: the check is on data.
    const agreeing = p.invoices.map((i) => ({
      number: i.number,
      date: i.date,
      amount: i.number === invoiceNumber ? dwsiAmount : i.amount,
    }))
    const again = run({ cited: agreeing })
    expect(failing(again.recipe, again.draft)).toEqual([])
  })

  it('refuses a request number already issued', () => {
    const { recipe, draft } = run({
      requests: [{ number: p.truth.issuedNumber, amount: REQUEST_AMOUNT }],
      positions: positionsRows().map((r) => ({ ...r, request: p.truth.issuedNumber })),
    })
    const anomaly = checks(recipe, draft).anomalies.find(
      (a) => (a.ref as { check: string }).check === 'request_number_new',
    )
    expect(anomaly).toMatchObject({
      code: 'recipe_check_failed',
      class: 'data',
      detail: { alreadyDeclared: 1 },
    })
  })

  it('refuses positions that do not add up to the order', () => {
    const rows = positionsRows().slice(0, 2)
    const { recipe, draft } = run({ positions: rows })
    expect(failing(recipe, draft)).toContain('positions_sum')
  })

  it('counts the requests already declared to the client against the order', () => {
    const { recipe, draft } = run()
    const declared = (number: number, amount: number, period: string): DeclaredValue => ({
      recipeSlug: 'sal-economico',
      sectionId: 'requests',
      cellId: declaredCellId('requests', 'amount', JSON.stringify([String(number)])),
      period,
      value: String(amount),
      declaredAt: `${period.slice(12)}T18:00:00.000Z`,
    })
    const issued = p.issuedRequests.map((r) =>
      declared(r.number, r.amount, `${r.periodFrom}..${r.periodTo}`),
    )
    expect(failing(recipe, draft, issued)).not.toContain('requests_within_order')
    // A request issued and not yet invoiced still counts: the order cannot be asked twice.
    const pending = declared(9, p.order.total - REQUEST_AMOUNT, '2026-09-01..2026-09-15')
    expect(failing(recipe, draft, [...issued, pending])).toContain('requests_within_order')
  })

  it('asks for the order chosen with its positions, and cites it with them', () => {
    const recipe = deliveryRecipe('sal-economico')
    const { order_doc: _, ...withoutOrder } = params()
    expect(() => checkParameterValues(recipe, withoutOrder)).toThrow(DomainError)
    const { draft } = run()
    const positions = blockIn(draft, 'positions')
    if (positions.kind !== 'table') throw new Error('no positions')
    const n = positions.rows[0]?.cells[2]?.sources[0]
    const note = draft.sourceNotes.find((x) => x.n === n)
    expect(note && 'ref' in note ? note.ref : null).toEqual({
      kind: 'parameter',
      parameterId: 'positions',
      evidenceIds: [EVIDENCE.order],
    })
  })

  it("cites the order only for what is copied from it, the progress as the PM's own", () => {
    const { draft } = run()
    const progress = blockIn(draft, 'progress')
    if (progress.kind !== 'table') throw new Error('no progress')
    const refOf = (column: number) => {
      const n = progress.rows[0]?.cells[column]?.sources[0]
      const note = draft.sourceNotes.find((x) => x.n === n)
      return note && 'ref' in note ? note.ref : null
    }
    expect(refOf(0)).toEqual({
      kind: 'parameter',
      parameterId: 'positions',
      evidenceIds: [EVIDENCE.order],
    })
    for (const column of [1, 2, 3]) {
      expect(refOf(column)).toEqual({ kind: 'parameter', parameterId: 'positions' })
    }
  })

  it('refuses requests beyond the total of the order', () => {
    const { recipe, draft } = run({
      requests: [{ number: p.truth.nextNumber, amount: p.order.total + 1000 }],
    })
    expect(failing(recipe, draft)).toContain('requests_within_order')
  })

  it('refuses a percent of the period that is not current minus previous', () => {
    const { recipe, draft } = run()
    const progress = blockIn(draft, 'progress')
    if (progress.kind !== 'table') throw new Error('no progress')
    ;(progress.rows[1]?.cells[4] as { text: string }).text = '99'
    expect(failing(recipe, draft)).toContain('period_pct')
  })

  it('refuses a previous percent other than the current one of the request before', () => {
    const rows = positionsRows().map((r) =>
      r.position === '2' ? { ...r, previous_pct: Number(r.previous_pct) - 5 } : r,
    )
    const { recipe, draft } = run({ positions: rows })
    expect(failing(recipe, draft)).toContain('previous_pct_as_declared')
    // The first request of a series has nothing declared before it.
    expect(failing(recipe, draft, [])).not.toContain('previous_pct_as_declared')
  })

  it('refuses a position that goes into a request this SAL does not make', () => {
    const rows = positionsRows().map((r) => (r.position === '3' ? { ...r, request: 9 } : r))
    const { recipe, draft } = run({ positions: rows })
    expect(failing(recipe, draft)).toContain('position_request_known')
  })

  it('refuses an invoice cited that the warehouse does not hold', () => {
    const cited = [{ number: 'FT-26-000', date: '2026-10-15', amount: 1000 }]
    const { recipe, draft } = run({ cited })
    expect(failing(recipe, draft)).toContain('cited_invoices_exist')
  })

  it('closes every position at 100% when the request brings the order to the end', () => {
    const { draft: base } = run()
    const residual = Number(
      (valueText(base, 'residual') as string).replace(/\./g, '').replace(',', '.'),
    )
    const closing = { number: p.truth.nextNumber, amount: residual }
    const open = run({ requests: [closing] })
    expect(failing(open.recipe, open.draft)).toContain('closing_complete')
    const full = positionsRows().map((r) => ({ ...r, current_pct: 100 }))
    const closed = run({ requests: [closing], positions: full })
    expect(failing(closed.recipe, closed.draft)).not.toContain('closing_complete')
  })

  it('keeps the mail free of waits, commitments and internal words', () => {
    const slots: Record<string, SlotContent> = {
      mail_text: {
        segments: [
          {
            text: 'Restiamo in attesa del vostro benestare.',
            nature: 'fact',
            category: 'other',
            sources: [],
          },
        ],
      },
    }
    const { recipe, draft } = run({}, deliveryRecipe('sal-economico'), slots)
    const anomaly = checks(recipe, draft).anomalies.find(
      (a) => (a.ref as { check: string }).check === 'mail_bounded',
    )
    expect(anomaly).toMatchObject({ class: 'form', detail: { phrases: 1 } })
  })
})
