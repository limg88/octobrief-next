import { FACT_KINDS, type FactKind } from '../knowledge.ts'
import { TRACKER_GROUP_FIELDS, type TrackerGroupField, type WORK_ITEM_FIELDS } from '../tracker.ts'

// The categories of data a value of a deliverable belongs to. The separation between the
// internal and the client version is decided per category, never per document: every column
// and every computed value of a recipe declares one, and the category of what it reads from a
// source is fixed here, in code.

export const DATA_CATEGORIES = [
  'contract_amounts',
  'invoiced_amounts',
  'costs',
  'margins',
  'rates',
  'estimates',
  'hours',
  'story_points',
  'personal',
  'other',
] as const
export type DataCategory = (typeof DATA_CATEGORIES)[number]

/**
 * How restrictive a category is: `other` (states, counts, titles, dates) the least; contract and
 * invoiced amounts next; story points (shown to the client only with an explicit confirmation);
 * the internal economics and hours; personal data the most. Categories of the same rank are
 * different things: one never stands for the other.
 */
const RESTRICTION: Readonly<Record<DataCategory, number>> = Object.freeze({
  other: 0,
  contract_amounts: 1,
  invoiced_amounts: 1,
  story_points: 2,
  hours: 3,
  estimates: 3,
  rates: 3,
  costs: 3,
  margins: 3,
  personal: 4,
})

/** What a source column nobody mapped is worth: the most restrictive category. */
export const MOST_RESTRICTIVE_CATEGORY: DataCategory = 'personal'

export function restrictionOf(category: DataCategory): number {
  return RESTRICTION[category]
}

/** Whether `a` is strictly more restrictive than `b`. */
export function isMoreRestrictive(a: DataCategory, b: DataCategory): boolean {
  return RESTRICTION[a] > RESTRICTION[b]
}

/** Rank of the internal economics and hours: never shown to the client, whatever the label. */
const INTERNAL_RANK = 3

/**
 * Whether a recipe may declare `declared` for data the source puts in `source`: the same
 * category, or a strictly more restrictive one. A lateral move is refused where it could change
 * what the client sees (an invoiced column declared as contract amounts: the two may be allowed
 * differently); among the internal economics and hours, which never reach the client, it holds.
 */
export function declarationHolds(declared: DataCategory, source: DataCategory): boolean {
  if (declared === source || isMoreRestrictive(declared, source)) return true
  return RESTRICTION[declared] === INTERNAL_RANK && RESTRICTION[source] === INTERNAL_RANK
}

/** The categories a value may reach the client with, by default: ordered, invoiced, project data. */
const CLIENT_TIER: readonly DataCategory[] = ['contract_amounts', 'invoiced_amounts', 'other']

/** The most restrictive of some categories (the first of the highest rank); `other` for none. */
export function mostRestrictiveOf(categories: readonly DataCategory[]): DataCategory {
  let out: DataCategory = 'other'
  for (const c of categories) if (isMoreRestrictive(c, out)) out = c
  return out
}

/**
 * The category of a value computed from operands of these (effective) categories. Computed only
 * from ordered amounts, invoiced amounts and project data, it stays client-allowed: `other` when
 * every operand is, else the first amount among the operands (the client projection admits it
 * operand by operand). Any other operand makes it the most restrictive operand.
 */
export function computedCategory(operands: readonly DataCategory[]): DataCategory {
  if (operands.every((o) => CLIENT_TIER.includes(o))) {
    return operands.find((o) => o !== 'other') ?? 'other'
  }
  return mostRestrictiveOf(operands)
}

/**
 * Whether a computed column or value may be declared `declared` from operands of these
 * (effective) categories. From client-allowed operands only: one of the operand categories (so
 * `other` only when every operand is, and contract or invoiced amounts only when one operand
 * is), or a category more restrictive than all of them. With any other operand: what a source of
 * the most restrictive operand would allow.
 */
export function computedDeclarationHolds(
  declared: DataCategory,
  operands: readonly DataCategory[],
): boolean {
  if (operands.every((o) => CLIENT_TIER.includes(o))) {
    // A value that involves an amount is never mere project data.
    if (declared === 'other') return operands.every((o) => o === 'other')
    return operands.includes(declared) || operands.every((o) => isMoreRestrictive(declared, o))
  }
  return declarationHolds(declared, mostRestrictiveOf(operands))
}

/** The fields of a work item, and its id, in the category the tracker gives them. */
export const TRACKER_FIELD_CATEGORIES: Readonly<Record<string, DataCategory>> = Object.freeze({
  id: 'other',
  summary: 'other',
  type: 'other',
  state: 'other',
  sprint: 'other',
  iteration: 'other',
  area: 'other',
  assignee: 'personal',
  story_points: 'story_points',
  priority: 'other',
  created: 'other',
  changed: 'other',
  closed: 'other',
  due: 'other',
  parent: 'other',
  tags: 'other',
  // The feature a work item stands under, as a grouping: its id, like the parent.
  feature: 'other',
} satisfies Record<'id' | 'feature' | (typeof WORK_ITEM_FIELDS)[number], DataCategory>)

/** The fields of a row of grouped counts of the tracker. */
export const TRACKER_COUNT_FIELDS = ['key', 'count', 'story_points'] as const

/**
 * The columns of the data warehouse views, in their category.
 *
 * Confirmed by Giovanni (07/11/2026): a cost column taken for an invoiced amount would carry an
 * internal figure to the client. Recognized revenue and backlog amounts are economic results,
 * treated as margins (internal): the residual to invoice of a client document is computed from
 * the ordered and invoiced amounts only. Planned and remaining work, and the percent complete the
 * warehouse derives from hours, are estimates. The text of an order or invoice item may carry
 * rates or days: internal. A column missing from this map is worth the most restrictive
 * category.
 */
export const DWSI_COLUMN_CATEGORIES: Readonly<
  Record<string, Readonly<Record<string, DataCategory>>>
> = deepFreeze({
  v_timesheet_all: {
    internalid: 'other',
    projectid: 'other',
    employee: 'personal',
    timesheetdate: 'hours',
    casetaskevent: 'hours',
    tipoore: 'hours',
    duration: 'hours',
    approvalstatus: 'hours',
    laborcosthh_new: 'rates',
    laborcost_new: 'costs',
  },
  v_project: {
    projectid: 'other',
    name: 'other',
    projectmanager: 'personal',
    customername: 'other',
    status: 'other',
    startdate: 'other',
    calculatedenddate: 'other',
    enddate: 'other',
    plannedwork: 'estimates',
    actualwork: 'hours',
    remainingwork: 'estimates',
    percentcomplete: 'estimates',
  },
  v_sales_order_all: {
    projectid: 'other',
    salesorderid: 'other',
    lineid: 'other',
    salesorderdate: 'other',
    status: 'other',
    item: 'rates',
    quantity: 'contract_amounts',
    amount: 'contract_amounts',
    invoiced: 'invoiced_amounts',
    closed: 'other',
  },
  v_invoice_all: {
    projectid: 'other',
    invoiceid: 'other',
    lineid: 'other',
    status: 'other',
    invoicedate: 'other',
    item: 'rates',
    amount: 'invoiced_amounts',
    annocompetenza: 'other',
    salesorder: 'other',
    type: 'other',
  },
  v_project_revenue_all: {
    projectid: 'other',
    anno: 'other',
    mese: 'other',
    itemgroup: 'other',
    cost: 'costs',
    actualcost: 'costs',
    revenue: 'margins',
    actualrevenue: 'margins',
  },
  v_database_pl_all: {
    projectid: 'other',
    anno: 'other',
    mese: 'other',
    revenue: 'margins',
    cost_labor_ts: 'costs',
    cost_total: 'costs',
  },
  v_backlog_all: {
    projectid: 'other',
    backlogrefperiod: 'other',
    amount: 'margins',
    amountbilled: 'invoiced_amounts',
    amountrecognized: 'margins',
  },
  dw_prod_projectpercentcomplete: {
    projectid: 'other',
    period: 'other',
    perioddate: 'other',
    percentcomplete: 'estimates',
    periodstatus: 'other',
  },
})

function deepFreeze<T extends Record<string, Record<string, DataCategory>>>(map: T): Readonly<T> {
  for (const inner of Object.values(map)) Object.freeze(inner)
  return Object.freeze(map)
}

/**
 * The columns that identify a row of each view of the warehouse for one project, in order: what
 * a citation of a row names. The same keys the extractor gives the rows.
 */
export const DWSI_VIEW_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  v_timesheet_all: Object.freeze(['internalid']),
  v_project: Object.freeze(['projectid']),
  v_sales_order_all: Object.freeze(['salesorderid', 'lineid']),
  v_invoice_all: Object.freeze(['invoiceid', 'lineid']),
  v_project_revenue_all: Object.freeze(['anno', 'mese', 'itemgroup']),
  v_database_pl_all: Object.freeze(['anno', 'mese']),
  v_backlog_all: Object.freeze(['backlogrefperiod']),
  dw_prod_projectpercentcomplete: Object.freeze(['period']),
})

/**
 * The columns of the warehouse that hold a decimal quantity or a calendar day, by view: the
 * warehouse may give them as text, and a recipe reads them as numbers and days. Every other
 * column (codes, integers that are identifiers, texts) is shown as the warehouse wrote it.
 */
export const DWSI_VALUE_KINDS: Readonly<
  Record<string, Readonly<Record<string, 'number' | 'day'>>>
> = Object.freeze({
  v_timesheet_all: Object.freeze({
    timesheetdate: 'day',
    duration: 'number',
    laborcosthh_new: 'number',
    laborcost_new: 'number',
  }),
  v_project: Object.freeze({
    startdate: 'day',
    calculatedenddate: 'day',
    enddate: 'day',
    plannedwork: 'number',
    actualwork: 'number',
    remainingwork: 'number',
    percentcomplete: 'number',
  }),
  v_sales_order_all: Object.freeze({
    salesorderdate: 'day',
    quantity: 'number',
    amount: 'number',
    invoiced: 'number',
  }),
  v_invoice_all: Object.freeze({ invoicedate: 'day', amount: 'number' }),
  v_project_revenue_all: Object.freeze({
    cost: 'number',
    actualcost: 'number',
    revenue: 'number',
    actualrevenue: 'number',
  }),
  v_database_pl_all: Object.freeze({
    revenue: 'number',
    cost_labor_ts: 'number',
    cost_total: 'number',
  }),
  v_backlog_all: Object.freeze({
    backlogrefperiod: 'day',
    amount: 'number',
    amountbilled: 'number',
    amountrecognized: 'number',
  }),
  dw_prod_projectpercentcomplete: Object.freeze({ perioddate: 'day', percentcomplete: 'number' }),
} as Record<string, Readonly<Record<string, 'number' | 'day'>>>)

/** The views of the warehouse a recipe can read: the declared ones, nothing else. */
export const DWSI_VIEW_NAMES: readonly string[] = Object.freeze(Object.keys(DWSI_COLUMN_CATEGORIES))

/** The fields of a fact a recipe can read. */
export const FACT_FIELDS = ['key', 'statement', 'value'] as const

/** The fields of a piece of evidence a recipe can list. */
export const EVIDENCE_FIELDS = ['title', 'date', 'kind'] as const

/** Kinds of fact whose content is personal, or of unknown economic nature. */
const FACT_KIND_CATEGORIES: Readonly<Partial<Record<FactKind, DataCategory>>> = Object.freeze({
  person: 'personal',
  economics: MOST_RESTRICTIVE_CATEGORY,
})

/** A column of a source, as a recipe reads it. */
export type SourceColumn =
  | { source: 'tracker'; field: string }
  | { source: 'tracker_counts'; field: string; groupBy: TrackerGroupField | null }
  | { source: 'system_rows'; view: string; column: string }
  /** `clientOnly`: the query reads only facts whose sources are all for the client. */
  | { source: 'facts'; factKind: FactKind; field: string; clientOnly: boolean }
  /** `clientOnly`: the query reads only evidence whose audience is the client. */
  | { source: 'evidence'; field: string; clientOnly: boolean }
  /** A value the PM typed: its category is the one the recipe declares. */
  | { source: 'parameter' }

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

/**
 * The category of what a source column holds. A column nobody mapped (a field the map does not
 * know, a view or a column of the warehouse outside the list) is worth the most restrictive
 * category.
 */
export function sourceColumnCategory(column: SourceColumn): DataCategory {
  switch (column.source) {
    case 'tracker':
      return own(TRACKER_FIELD_CATEGORIES, column.field) ?? MOST_RESTRICTIVE_CATEGORY
    case 'tracker_counts':
      if (column.field === 'count') return 'other'
      if (column.field === 'story_points') return 'story_points'
      if (column.field === 'key' && column.groupBy !== null) {
        return own(TRACKER_FIELD_CATEGORIES, column.groupBy) ?? MOST_RESTRICTIVE_CATEGORY
      }
      return MOST_RESTRICTIVE_CATEGORY
    case 'system_rows': {
      const view = own(DWSI_COLUMN_CATEGORIES, column.view)
      return (view && own(view, column.column)) ?? MOST_RESTRICTIVE_CATEGORY
    }
    case 'facts':
      if (!FACT_KINDS.includes(column.factKind)) return MOST_RESTRICTIVE_CATEGORY
      if (!(FACT_FIELDS as readonly string[]).includes(column.field)) {
        return MOST_RESTRICTIVE_CATEGORY
      }
      return (
        FACT_KIND_CATEGORIES[column.factKind] ??
        (column.clientOnly ? 'other' : MOST_RESTRICTIVE_CATEGORY)
      )
    case 'evidence':
      if (column.field === 'title') return column.clientOnly ? 'other' : MOST_RESTRICTIVE_CATEGORY
      if (column.field === 'date' || column.field === 'kind') return 'other'
      return MOST_RESTRICTIVE_CATEGORY
    case 'parameter':
      return 'other'
  }
}

/** Whether a field is one a grouping of the tracker can be done by. */
export function isTrackerGroupField(field: string): field is TrackerGroupField {
  return (TRACKER_GROUP_FIELDS as readonly string[]).includes(field)
}
