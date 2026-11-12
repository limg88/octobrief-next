import { describe, expect, it } from 'vitest'
import {
  computedCategory,
  computedDeclarationHolds,
  DATA_CATEGORIES,
  DWSI_COLUMN_CATEGORIES,
  declarationHolds,
  isMoreRestrictive,
  MOST_RESTRICTIVE_CATEGORY,
  parameterCitation,
  restrictionOf,
  sourceColumnCategory,
  TRACKER_FIELD_CATEGORIES,
  WORK_ITEM_FIELDS,
} from '../src/recipe/index.ts'

describe('data categories', () => {
  it('treats an unmapped source column as the most restrictive category', () => {
    expect(MOST_RESTRICTIVE_CATEGORY).toBe('personal')
    for (const c of DATA_CATEGORIES) {
      expect(restrictionOf(MOST_RESTRICTIVE_CATEGORY)).toBeGreaterThanOrEqual(restrictionOf(c))
    }
    expect(
      sourceColumnCategory({ source: 'system_rows', view: 'v_invoice_all', column: 'memo' }),
    ).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(
      sourceColumnCategory({ source: 'system_rows', view: 'v_unknown', column: 'amount' }),
    ).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(sourceColumnCategory({ source: 'tracker', field: 'custom_field' })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
    expect(sourceColumnCategory({ source: 'tracker', field: 'constructor' })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
    expect(sourceColumnCategory({ source: 'tracker_counts', field: 'other', groupBy: null })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
    expect(sourceColumnCategory({ source: 'tracker_counts', field: 'key', groupBy: null })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
    expect(
      sourceColumnCategory({
        source: 'facts',
        factKind: 'risk',
        field: 'sources',
        clientOnly: true,
      }),
    ).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(
      sourceColumnCategory({
        source: 'facts',
        factKind: 'gossip' as never,
        field: 'statement',
        clientOnly: true,
      }),
    ).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(sourceColumnCategory({ source: 'evidence', field: 'text', clientOnly: true })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
  })

  it('maps the costs, rates and revenue of the warehouse as internal', () => {
    const of = (view: string, column: string) =>
      sourceColumnCategory({ source: 'system_rows', view, column })
    expect(of('v_timesheet_all', 'laborcost_new')).toBe('costs')
    expect(of('v_timesheet_all', 'laborcosthh_new')).toBe('rates')
    expect(of('v_timesheet_all', 'duration')).toBe('hours')
    expect(of('v_timesheet_all', 'employee')).toBe('personal')
    expect(of('v_project_revenue_all', 'actualcost')).toBe('costs')
    expect(of('v_project_revenue_all', 'revenue')).toBe('margins')
    expect(of('v_database_pl_all', 'cost_total')).toBe('costs')
    expect(of('v_project', 'plannedwork')).toBe('estimates')
  })

  it('keeps the text of an order or invoice item internal, as it may carry rates or days', () => {
    const of = (view: string, column: string) =>
      sourceColumnCategory({ source: 'system_rows', view, column })
    expect(of('v_sales_order_all', 'item')).toBe('rates')
    expect(of('v_invoice_all', 'item')).toBe('rates')
    expect(of('v_backlog_all', 'amount')).toBe('margins')
  })

  it('lets only ordered and invoiced amounts of the warehouse through as client amounts', () => {
    const clientAmounts: string[] = []
    for (const [view, columns] of Object.entries(DWSI_COLUMN_CATEGORIES)) {
      for (const [column, category] of Object.entries(columns)) {
        if (category === 'contract_amounts' || category === 'invoiced_amounts') {
          clientAmounts.push(`${view}.${column}`)
        }
      }
    }
    expect(clientAmounts.sort()).toEqual([
      'v_backlog_all.amountbilled',
      'v_invoice_all.amount',
      'v_sales_order_all.amount',
      'v_sales_order_all.invoiced',
      'v_sales_order_all.quantity',
    ])
  })

  it('maps every field of a work item, with assignees personal and story points apart', () => {
    for (const f of WORK_ITEM_FIELDS) expect(TRACKER_FIELD_CATEGORIES[f]).toBeDefined()
    expect(sourceColumnCategory({ source: 'tracker', field: 'assignee' })).toBe('personal')
    expect(sourceColumnCategory({ source: 'tracker', field: 'story_points' })).toBe('story_points')
    expect(sourceColumnCategory({ source: 'tracker', field: 'state' })).toBe('other')
    expect(
      sourceColumnCategory({ source: 'tracker_counts', field: 'count', groupBy: 'state' }),
    ).toBe('other')
    expect(
      sourceColumnCategory({ source: 'tracker_counts', field: 'story_points', groupBy: 'state' }),
    ).toBe('story_points')
    expect(
      sourceColumnCategory({ source: 'tracker_counts', field: 'key', groupBy: 'assignee' }),
    ).toBe('personal')
  })

  it('keeps facts restrictive unless the query reads client facts only, and people always', () => {
    const fact = (factKind: 'person' | 'economics' | 'risk', clientOnly: boolean) =>
      sourceColumnCategory({ source: 'facts', factKind, field: 'value', clientOnly })
    expect(fact('person', true)).toBe('personal')
    expect(fact('economics', true)).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(fact('risk', false)).toBe(MOST_RESTRICTIVE_CATEGORY)
    expect(fact('risk', true)).toBe('other')
    expect(sourceColumnCategory({ source: 'evidence', field: 'title', clientOnly: false })).toBe(
      MOST_RESTRICTIVE_CATEGORY,
    )
    expect(sourceColumnCategory({ source: 'evidence', field: 'title', clientOnly: true })).toBe(
      'other',
    )
    expect(sourceColumnCategory({ source: 'evidence', field: 'date', clientOnly: false })).toBe(
      'other',
    )
    expect(sourceColumnCategory({ source: 'parameter' })).toBe('other')
  })

  it('orders categories by how restrictive they are', () => {
    expect(isMoreRestrictive('costs', 'invoiced_amounts')).toBe(true)
    expect(isMoreRestrictive('invoiced_amounts', 'contract_amounts')).toBe(false)
    expect(declarationHolds('contract_amounts', 'invoiced_amounts')).toBe(false)
    expect(declarationHolds('costs', 'rates')).toBe(true)
    expect(declarationHolds('other', 'costs')).toBe(false)
    expect(declarationHolds('personal', 'other')).toBe(true)
  })

  it('cites a selection of the PM as what was selected, a typed value as «indicato da te»', () => {
    expect(parameterCitation('evidence_selection')).toBe('evidence')
    expect(parameterCitation('work_item_selection')).toBe('work_item')
    expect(parameterCitation('number')).toBe('pm')
    expect(parameterCitation('period')).toBe('pm')
  })

  it('a value computed only from contract and invoiced amounts is client-allowed', () => {
    expect(computedCategory(['contract_amounts', 'invoiced_amounts'])).toBe('contract_amounts')
    expect(computedCategory(['invoiced_amounts', 'other'])).toBe('invoiced_amounts')
    expect(computedCategory(['other', 'other'])).toBe('other')
    expect(
      computedDeclarationHolds('contract_amounts', ['contract_amounts', 'invoiced_amounts']),
    ).toBe(true)
  })

  it('a ratio of invoiced over contract amounts may be declared invoiced but not other', () => {
    const ops = ['invoiced_amounts', 'contract_amounts'] as const
    expect(computedDeclarationHolds('invoiced_amounts', ops)).toBe(true)
    expect(computedDeclarationHolds('other', ops)).toBe(false)
    expect(computedDeclarationHolds('costs', ops)).toBe(true)
    expect(computedDeclarationHolds('contract_amounts', ['invoiced_amounts', 'other'])).toBe(false)
    expect(computedDeclarationHolds('other', ['other', 'other'])).toBe(true)
  })

  it('a value computed from a contract amount and project data cannot be declared other', () => {
    expect(computedDeclarationHolds('other', ['contract_amounts', 'other'])).toBe(false)
    expect(computedDeclarationHolds('other', ['other', 'invoiced_amounts'])).toBe(false)
    expect(computedDeclarationHolds('contract_amounts', ['contract_amounts', 'other'])).toBe(true)
  })

  it('a ratio of an amount over a parameter cannot be declared other', () => {
    // A parameter typed by the PM is project data (`other`).
    expect(computedDeclarationHolds('other', ['invoiced_amounts', 'other'])).toBe(false)
    expect(computedDeclarationHolds('invoiced_amounts', ['invoiced_amounts', 'other'])).toBe(true)
  })

  it('a value computed from a cost and an invoiced amount takes the cost category', () => {
    expect(computedCategory(['costs', 'invoiced_amounts'])).toBe('costs')
    expect(computedDeclarationHolds('invoiced_amounts', ['costs', 'invoiced_amounts'])).toBe(false)
    expect(computedDeclarationHolds('margins', ['costs', 'invoiced_amounts'])).toBe(true)
    expect(computedDeclarationHolds('costs', ['costs', 'personal'])).toBe(false)
  })
})
