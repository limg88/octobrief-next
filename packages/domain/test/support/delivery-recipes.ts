// The delivery recipes of `recipes/` run on the synthetic «delivery» project (Lot 11b): what a run
// would gather, built by hand from the twins of the project the way the gathering reads its
// sources (tracker rows and counts, rows of the warehouse, evidence chosen by the PM, values and
// tables the PM typed). Synthetic data only.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DeliveryRecipeProject,
  generateDeliveryRecipeProject,
} from '../../../../tools/synthetic/src/recipe-data.ts'
import {
  type AudienceContext,
  buildSkeleton,
  canonicalJson,
  clientPolicy,
  type DeliverableDocument,
  type DocumentSourceRef,
  DWSI_VALUE_KINDS,
  DWSI_VIEW_KEYS,
  type EvidenceAudience,
  type FieldValue,
  type GatheredBlock,
  type GatheredData,
  type GatheredNote,
  type GatheredRow,
  groupWorkItems,
  type InternalDocument,
  matchesTrackerFilter,
  mergeDocument,
  type ParameterValues,
  parameterTitleTexts,
  periodsOf,
  type Recipe,
  type RecipeBlock,
  type RecipeQuery,
  romeDateString,
  type SlotContent,
  type SourceId,
  sortWorkItems,
  type TrackerFilter,
  typedRowsRead,
  validateRecipe,
  type WorkItem,
} from '../../src/recipe/index.ts'

export const DELIVERY_SLUGS = ['sal-economico', 'closing-status', 'deliverable-sprint'] as const
export type DeliverySlug = (typeof DELIVERY_SLUGS)[number]

const RECIPES = join(import.meta.dirname, '../../../../recipes')

/** The file of a recipe of the library, as `pnpm recipes:publish` reads it. */
export function recipeFile(slug: DeliverySlug): { changeSummary: unknown; recipe: unknown } {
  return JSON.parse(readFileSync(join(RECIPES, `${slug}.json`), 'utf8'))
}

/** A recipe of the library, validated; a copy of its raw form changes with `change`. */
export function deliveryRecipe(
  slug: DeliverySlug,
  change: (raw: Record<string, unknown> & RawRecipe) => void = () => {},
): Recipe {
  const raw = structuredClone(recipeFile(slug).recipe) as Record<string, unknown> & RawRecipe
  change(raw)
  const v = validateRecipe(raw)
  if (!v.ok) throw new Error(`invalid recipe ${slug}: ${JSON.stringify(v.errors)}`)
  return v.recipe
}

export interface RawRecipe {
  parameters: Array<Record<string, unknown>>
  sections: Array<Record<string, unknown> & { id: string; blocks: Array<Record<string, unknown>> }>
  checks: Array<Record<string, unknown> & { id: string }>
}

export const SEED = 7
export const project = (): DeliveryRecipeProject => generateDeliveryRecipeProject({ seed: SEED })

export const TRACKER: SourceId = 'src-tracker' as SourceId
export const DWSI: SourceId = 'src-dwsi' as SourceId
const TRACKER_AS_OF = '2026-11-05T06:00:00.000Z'
const DWSI_AS_OF = '2026-11-04T22:00:00.000Z'

/** The id of each document of the project, by its role. */
export const EVIDENCE = {
  order: 'ev-order',
  invoice1: 'ev-invoice-1',
  invoice2: 'ev-invoice-2',
  contract: 'ev-contract',
  team: 'ev-team',
  backlog: 'ev-backlog',
  standup1: 'ev-standup-1',
  standup2: 'ev-standup-2',
  transcript: 'ev-transcript',
} as const

const EVIDENCE_KINDS: Readonly<Record<string, EvidenceAudience['kind']>> = {
  [EVIDENCE.order]: 'purchase_order',
  [EVIDENCE.invoice1]: 'invoice',
  [EVIDENCE.invoice2]: 'invoice',
  [EVIDENCE.contract]: 'contract_deliverables',
  [EVIDENCE.team]: 'generic',
  [EVIDENCE.backlog]: 'backlog_export',
  [EVIDENCE.standup1]: 'status_report',
  [EVIDENCE.standup2]: 'status_report',
  [EVIDENCE.transcript]: 'transcript',
}

/** What the client gate knows of every document of the project. */
export function evidenceOf(p: DeliveryRecipeProject): Record<string, EvidenceAudience> {
  const ids = Object.values(EVIDENCE)
  const out: Record<string, EvidenceAudience> = {}
  p.documents.forEach((d, i) => {
    const id = ids[i] as string
    out[id] = {
      kind: EVIDENCE_KINDS[id] as EvidenceAudience['kind'],
      audience: d.audience,
      fromSystem: false,
      title: d.fileName,
    }
  })
  return out
}

/** The work items of the synthetic tracker, as the product reads them. */
export function workItemsOf(p: DeliveryRecipeProject): WorkItem[] {
  return p.tracker.items.map((t) => ({
    sourceId: TRACKER,
    externalId: t.id,
    url: null,
    summary: t.title,
    type: t.type,
    state: t.state,
    sprint: t.sprint,
    // As Azure DevOps writes it: the sprint is the last part of the iteration path.
    iteration: `${p.projectName}\\${t.sprint}`,
    area: null,
    assignee: t.assignee,
    storyPoints: t.storyPoints,
    priority: t.priority,
    // As Azure DevOps gives them: the day of creation (none for a version read before the
    // connector read it), of the last change and of closing.
    created: t.created === null ? null : new Date(`${t.created}T09:00:00.000Z`),
    changed: new Date(`${t.changed}T10:00:00.000Z`),
    closed: t.state === 'Done' ? new Date(`${t.changed}T10:00:00.000Z`) : null,
    due: null,
    parent: t.feature,
    tags: [],
  }))
}

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>

/** A date of the tracker as a block reads it: its calendar day in Italy. */
const dayOf = (d: Date | null): FieldValue => (d === null ? null : { day: romeDateString(d) })

/** The documents chosen in the evidence parameter a table was copied from. */
function copiedFrom(params: ParameterValues, evidence: string | undefined): string[] {
  const v = evidence === undefined ? undefined : params[evidence]
  return v?.type === 'evidence_selection' ? [...v.evidenceIds] : []
}

class Gathering {
  readonly notes = new Map<string, GatheredNote>()
  readonly reads: Array<{ ref: DocumentSourceRef; values: Record<string, FieldValue> }> = []

  private readonly recipe: Recipe
  private readonly p: DeliveryRecipeProject
  private readonly params: ParameterValues
  private readonly items: WorkItem[]

  constructor(
    recipe: Recipe,
    p: DeliveryRecipeProject,
    params: ParameterValues,
    items: WorkItem[],
  ) {
    this.recipe = recipe
    this.p = p
    this.params = params
    this.items = items
  }

  note(ref: DocumentSourceRef, label: string, dataAsOf: string | null): DocumentSourceRef {
    const key = canonicalJson(ref)
    if (!this.notes.has(key)) this.notes.set(key, { ref, label, dataAsOf })
    return ref
  }

  private filterValue(v: string | { parameter: string }): string | null {
    if (typeof v === 'string') return v
    const value = this.params[v.parameter]
    if (value?.type === 'text' || value?.type === 'choice') return value.value
    return null
  }

  /** A day the PM gave in a date parameter. */
  private day(v: string | { parameter: string } | undefined): string | undefined {
    if (v === undefined || typeof v === 'string') return v
    const p = this.params[v.parameter]
    return p?.type === 'date' ? p.day : undefined
  }

  /** The dates of a tracker query; null when the PM skipped the date it needs. */
  private trackerDates(
    q: Extract<RecipeQuery, { kind: 'tracker' }>,
  ): TrackerFilter['dates'] | null {
    const d = q.filter.dates
    if (d === undefined) return undefined
    const period = d.period === undefined ? undefined : this.params[d.period.parameter]
    if (d.period !== undefined && period?.type !== 'period') return null
    const from = period?.type === 'period' ? period.from : this.day(d.from)
    const to = period?.type === 'period' ? period.to : this.day(d.to)
    if ((d.from !== undefined && from === undefined) || (d.to !== undefined && to === undefined)) {
      return null
    }
    return {
      field: d.field,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    }
  }

  private trackerFilter(q: Extract<RecipeQuery, { kind: 'tracker' }>): TrackerFilter {
    const out: Record<string, string[]> = {}
    for (const field of ['types', 'excludedTypes', 'states', 'sprints', 'iterations'] as const) {
      const list = q.filter[field]
      if (list === undefined) continue
      out[field] = list.flatMap((v) => {
        const table = typeof v === 'object' ? this.params[v.parameter] : undefined
        if (table?.type === 'rows') return table.rows.flatMap((r) => Object.values(r).map(String))
        const value = this.filterValue(v)
        return value === null ? [] : [value]
      })
    }
    return out
  }

  /** The decisions of the PM: excluded items out, attributed ones under their parent in counts. */
  private decided(q: Extract<RecipeQuery, { kind: 'tracker' }>): WorkItem[] {
    const d = q.decisions
    if (d === undefined) return this.items
    const excluded = d.excluded === undefined ? undefined : this.params[d.excluded.parameter]
    const left = new Set(
      excluded?.type === 'work_item_selection' ? excluded.items.map((i) => i.id) : [],
    )
    const table =
      d.attributions === undefined || q.groupBy === undefined
        ? undefined
        : this.params[d.attributions.parameter]
    const parents = new Map<string, string>()
    if (table?.type === 'rows' && d.attributions !== undefined) {
      for (const r of table.rows) {
        parents.set(String(r[d.attributions.item]), String(r[d.attributions.parent]))
      }
    }
    return this.items
      .filter((i) => !left.has(i.externalId))
      .map((i) => {
        const parent = parents.get(i.externalId)
        return parent === undefined ? i : { ...i, parent }
      })
  }

  private itemRow(i: WorkItem): GatheredRow {
    const ref = this.note(
      { kind: 'work_item', sourceId: i.sourceId, id: i.externalId },
      `Tracker, elemento ${i.externalId}`,
      TRACKER_AS_OF,
    )
    const values: Record<string, FieldValue> = {
      id: i.externalId,
      summary: i.summary,
      type: i.type,
      state: i.state,
      sprint: i.sprint,
      story_points: i.storyPoints,
      parent: i.parent,
      priority: i.priority,
      created: dayOf(i.created),
      changed: dayOf(i.changed),
      closed: dayOf(i.closed),
    }
    this.reads.push({ ref, values })
    return { values, refs: Object.fromEntries(Object.keys(values).map((k) => [k, ref])) }
  }

  private tracker(blockId: string, q: Extract<RecipeQuery, { kind: 'tracker' }>): GatheredBlock {
    const dates = this.trackerDates(q)
    if (dates === null) return { status: 'not_deduced', reason: 'parameter_skipped' }
    const filter = {
      ...this.trackerFilter(q),
      ...(dates === undefined ? {} : { dates }),
      ...(q.filter.undated === undefined ? {} : { undated: q.filter.undated }),
    }
    const matched = sortWorkItems(this.decided(q).filter((i) => matchesTrackerFilter(i, filter)))
    const counts = this.note(
      { kind: 'work_item_counts', sourceId: TRACKER, query: blockId },
      'Tracker, conteggi',
      TRACKER_AS_OF,
    )
    if (q.groupBy === undefined) {
      return { status: 'read', rows: matched.map((i) => this.itemRow(i)), totals: [counts] }
    }
    const rows = groupWorkItems(matched, q.groupBy, this.decided(q)).map((g): GatheredRow => {
      const values = { key: g.key, count: g.count, story_points: g.storyPoints }
      return { values, refs: { key: counts, count: counts, story_points: counts } }
    })
    return { status: 'read', rows, totals: [counts] }
  }

  private system(q: Extract<RecipeQuery, { kind: 'system_rows' }>): GatheredBlock {
    const kinds = DWSI_VALUE_KINDS[q.view] ?? {}
    const keys = ['projectid', ...(DWSI_VIEW_KEYS[q.view] ?? [])]
    const period = q.dates === undefined ? undefined : this.params[q.dates.period.parameter]
    if (q.dates !== undefined && period?.type !== 'period') {
      return { status: 'not_deduced', reason: 'parameter_skipped' }
    }
    const rows = (this.p.dwsi[q.view] ?? [])
      .filter((r) => {
        if (q.dates === undefined || period?.type !== 'period') return true
        const day = r[q.dates.column]
        return typeof day === 'string' && day >= period.from && day <= period.to
      })
      .filter((r) =>
        (q.where ?? []).every((w) => {
          const want = typeof w.equals === 'object' ? this.filterValue(w.equals) : w.equals
          return String(r[w.column]) === String(want)
        }),
      )
      .map((r): GatheredRow => {
        const ref = this.note(
          {
            kind: 'system_row',
            sourceId: DWSI,
            view: q.view,
            key: keys.map((column) => ({ column, value: String(r[column] ?? '') })),
          },
          `DWSI, ${q.view}`,
          DWSI_AS_OF,
        )
        const values: Record<string, FieldValue> = {}
        for (const [column, v] of Object.entries(r)) {
          values[column] =
            kinds[column] === 'day' && typeof v === 'string'
              ? { day: v }
              : (v as Exclude<FieldValue, { day: string }>)
        }
        this.reads.push({ ref, values })
        return { values, refs: Object.fromEntries(Object.keys(values).map((k) => [k, ref])) }
      })
    return { status: 'read', rows, totals: [] }
  }

  private parameter(q: Extract<RecipeQuery, { kind: 'parameter' }>): GatheredBlock {
    const v = this.params[q.parameter]
    if (v === undefined) return { status: 'not_deduced', reason: 'parameter_skipped' }
    if (v.type === 'rows') {
      const p = this.recipe.parameters.find((x) => x.id === q.parameter)
      if (p?.type !== 'rows') throw new Error('not a table')
      return {
        status: 'read',
        rows: typedRowsRead(p.id, p.columns, v.rows, copiedFrom(this.params, p.evidence)),
        totals: [],
      }
    }
    if (v.type === 'work_item_selection') {
      const rows = v.items.flatMap((s) => {
        const i = this.items.find((x) => x.externalId === s.id)
        return i ? [this.itemRow(i)] : []
      })
      return { status: 'read', rows, totals: [] }
    }
    if (v.type === 'evidence_selection') {
      const evidence = evidenceOf(this.p)
      const rows = v.evidenceIds.map((id): GatheredRow => {
        const e = evidence[id]
        if (!e) throw new Error(`unknown evidence ${id}`)
        const ref = this.note(
          { kind: 'evidence', evidenceId: id, locator: { kind: 'paragraph', index: 1 } },
          e.title,
          '2026-11-01T00:00:00.000Z',
        )
        const values = { title: e.title, date: { day: '2026-11-01' }, kind: e.kind }
        return { values, refs: { title: ref, date: ref, kind: ref } }
      })
      return { status: 'read', rows, totals: [] }
    }
    throw new Error('a single value is not a block in these recipes')
  }

  block(b: RowsBlock): GatheredBlock {
    switch (b.query.kind) {
      case 'tracker':
        return this.tracker(b.id, b.query)
      case 'system_rows':
        return this.system(b.query)
      case 'parameter':
        return this.parameter(b.query)
      // The synthetic project holds no facts: the lists of facts are read and empty.
      case 'facts':
      case 'evidence':
        return { status: 'read', rows: [], totals: [] }
    }
  }
}

/** What a run of `recipe` with these values gathers on the synthetic project. */
export function gatherDelivery(
  recipe: Recipe,
  p: DeliveryRecipeProject,
  params: ParameterValues,
  items: WorkItem[] = workItemsOf(p),
): GatheredData {
  const g = new Gathering(recipe, p, params, items)
  for (const param of recipe.parameters) {
    if (!Object.hasOwn(params, param.id)) continue
    const ids = param.type === 'rows' ? copiedFrom(params, param.evidence) : []
    g.note({ kind: 'parameter', parameterId: param.id }, `Indicato da te: ${param.label}`, null)
    if (ids.length > 0) {
      g.note(
        { kind: 'parameter', parameterId: param.id, evidenceIds: ids },
        `Indicato da te, dai documenti scelti: ${param.label}`,
        null,
      )
    }
  }
  const blocks: Record<string, GatheredBlock> = {}
  for (const s of recipe.sections) {
    for (const b of s.blocks) {
      if (b.kind === 'data_table' || b.kind === 'data_list') blocks[b.id] = g.block(b)
    }
  }
  return {
    recipe: { slug: recipe.slug, version: recipe.version },
    lang: 'it',
    referenceTime: p.now.toISOString(),
    parameters: params,
    parameterTexts: parameterTitleTexts(recipe, params, 'it'),
    periods: periodsOf(params),
    blocks,
    notes: [...g.notes.values()],
    readLog: g.reads,
    freshness: [],
    contradictions: [],
    contestedFacts: [],
    removedEvidence: [],
    context: {
      evidence: evidenceOf(p),
      facts: {},
      freshness: {
        now: p.now.toISOString(),
        thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
        sourceKinds: { [TRACKER]: 'ado', [DWSI]: 'netsuite_dwsi' },
        evidence: {},
        facts: {},
      },
    },
  }
}

/** The skeleton of a run, and its draft with the slots the writer filled (none: «non dedotto»). */
export function draftOf(
  recipe: Recipe,
  gathered: GatheredData,
  slots: Readonly<Record<string, SlotContent>> = {},
): { skeleton: ReturnType<typeof buildSkeleton>['skeleton']; draft: InternalDocument } {
  const { skeleton } = buildSkeleton(recipe, gathered)
  const draft = mergeDocument(skeleton, slots)
  if (draft.audience !== 'internal') throw new Error('the draft is internal')
  return { skeleton, draft }
}

/** What the client gate needs to project the client version of a run. */
export function audienceOf(recipe: Recipe, gathered: GatheredData): AudienceContext {
  return {
    recipe,
    policy: clientPolicy(),
    evidence: gathered.context.evidence,
    facts: {},
    parameters: gathered.parameterTexts,
  }
}

type Block = InternalDocument['sections'][number]['blocks'][number]

/** A block of a document by id. */
export function blockIn(doc: DeliverableDocument | InternalDocument, id: string): Block {
  for (const s of doc.sections) {
    const b = s.blocks.find((x) => x.id === id)
    if (b) return b as Block
  }
  throw new Error(`no block ${id}`)
}

/** The texts of the cells of a table, row by row. */
export function cellsOf(
  doc: DeliverableDocument | InternalDocument,
  id: string,
): Array<Array<string | null>> {
  const b = blockIn(doc, id)
  if (b.kind !== 'table' && b.kind !== 'list') throw new Error(`${id} is not a table`)
  return (b.kind === 'table' ? b.rows : b.items).map((r) => r.cells.map((c) => c.text))
}

/** The text of a value block. */
export function valueText(doc: DeliverableDocument | InternalDocument, id: string): string | null {
  const b = blockIn(doc, id)
  if (b.kind !== 'value') throw new Error(`${id} is not a value`)
  return b.cell.text
}

// The SAL of the synthetic project ---------------------------------------------------------------

/** The period of the third request of the order. */
export const SAL_PERIOD = { type: 'period', from: '2026-10-01', to: '2026-10-31' } as const
/** The percent the third request brings the second position to. */
export const SAL_CURRENT_2 = 80

export interface SalOver {
  positions?: Array<Record<string, string | number>>
  requests?: Array<Record<string, string | number>>
  cited?: Array<Record<string, string | number>>
}

const lastRequest = (p: DeliveryRecipeProject) =>
  p.issuedRequests.at(-1) as DeliveryRecipeProject['issuedRequests'][number]

/** What the third request asks: the second position from its last percent to 80%. */
export function salRequestAmount(p: DeliveryRecipeProject): number {
  const line2 = p.order.lines[1] as DeliveryRecipeProject['order']['lines'][number]
  return Math.round((line2.amount * (SAL_CURRENT_2 - (lastRequest(p).progress[2] ?? 0))) / 100)
}

/** The lines of the order as the PM copies them, with the progress of the third request. */
export function salPositions(p: DeliveryRecipeProject): Array<Record<string, string | number>> {
  const last = lastRequest(p)
  return p.order.lines.map((l) => ({
    position: String(l.position),
    item: l.description,
    amount: l.amount,
    request: p.truth.nextNumber,
    previous_pct: last.progress[l.position] ?? 0,
    current_pct: l.position === 2 ? SAL_CURRENT_2 : (last.progress[l.position] ?? 0),
  }))
}

/** The values the PM gives the SAL for the third request. */
export function salParams(p: DeliveryRecipeProject, over: SalOver = {}): ParameterValues {
  return {
    period: SAL_PERIOD,
    order_doc: { type: 'evidence_selection', evidenceIds: [EVIDENCE.order] },
    order_number: { type: 'text', value: p.order.number },
    order_date: { type: 'date', day: p.order.date },
    order_total: { type: 'number', value: p.order.total },
    positions: { type: 'rows', rows: over.positions ?? salPositions(p) },
    requests: {
      type: 'rows',
      rows: over.requests ?? [{ number: p.truth.nextNumber, amount: salRequestAmount(p) }],
    },
    invoice_docs: {
      type: 'evidence_selection',
      evidenceIds: [EVIDENCE.invoice1, EVIDENCE.invoice2],
    },
    cited_invoices: {
      type: 'rows',
      rows:
        over.cited ?? p.invoices.map((i) => ({ number: i.number, date: i.date, amount: i.amount })),
    },
  }
}
