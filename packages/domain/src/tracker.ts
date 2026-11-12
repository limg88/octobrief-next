import { canonicalText } from './canonical.ts'
import type { SourceId } from './ids.ts'
import { type Lang, vocabulary } from './language/index.ts'
import { shownNumbersIn } from './numbers.ts'
import { isCalendarDate, romeDateString, romeMidnight } from './rome-time.ts'
import { detectSuspicious, type SuspiciousPattern } from './suspicious.ts'

// The tracker history as the product reads it: the structured records of the work items of a
// tracker source (Azure DevOps, Jira), brought to one shape, filtered and counted by code. The
// model never queries in free text: it gives structured filters and reads the rows and the
// counts the code computed, each citable.

/** The tracker sources: only these have a tracker history. */
export const TRACKER_SOURCE_KINDS = ['ado', 'jira'] as const
export type TrackerSourceKind = (typeof TRACKER_SOURCE_KINDS)[number]

/** The fields of a work item as the product shows them, whatever the tracker. */
export const WORK_ITEM_FIELDS = [
  'summary',
  'type',
  'state',
  'sprint',
  'iteration',
  'area',
  'assignee',
  'story_points',
  'priority',
  'created',
  'changed',
  'closed',
  'due',
  'parent',
  'tags',
] as const
export type WorkItemField = (typeof WORK_ITEM_FIELDS)[number]

/**
 * Where a datum of the tracker sits: one work item (or one field of it) of a tracker source, or
 * the counts one call of the tool computed on the work items of that source (`query`: the id of
 * the call in the run, `q1`, `q2`, …). A citation of counts without the call verifies nothing.
 */
export type TrackerLocator =
  | { kind: 'work_item'; id: string; field?: WorkItemField }
  | { kind: 'work_item_counts'; query?: string }

/** The id of a call of the tracker tool in a run. */
const QUERY_ID = /^q[1-9]\d{0,3}$/

/** The id of the `n`-th call (from 1) of the tracker tool in a run. */
export function trackerQueryId(n: number): string {
  return `q${n}`
}

/**
 * Work items read at most to count a tracker: beyond it counts would be partial, so none are
 * given.
 */
export const MAX_TRACKER_ITEMS_SCANNED = 20_000

/** Longest external id of a work item, as the tracker history stores it. */
export const MAX_WORK_ITEM_ID = 512

/** Whether `value` has the shape of a tracker locator; extra properties never count. */
export function isTrackerLocator(value: unknown): value is TrackerLocator {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'work_item_counts') {
    return v.query === undefined || (typeof v.query === 'string' && QUERY_ID.test(v.query))
  }
  if (v.kind !== 'work_item') return false
  if (typeof v.id !== 'string' || v.id.trim() === '' || v.id.length > MAX_WORK_ITEM_ID) {
    return false
  }
  return v.field === undefined || WORK_ITEM_FIELDS.includes(v.field as WorkItemField)
}

/** The locator rebuilt with the fields of its kind only. */
export function canonicalTrackerLocator(locator: TrackerLocator): TrackerLocator {
  if (locator.kind === 'work_item_counts') {
    return locator.query === undefined
      ? { kind: 'work_item_counts' }
      : { kind: 'work_item_counts', query: locator.query }
  }
  return locator.field === undefined
    ? { kind: 'work_item', id: locator.id }
    : { kind: 'work_item', id: locator.id, field: locator.field }
}

/** Stable string identifying a place of the tracker, e.g. `work_item:42#state`. */
export function trackerLocatorKey(locator: TrackerLocator): string {
  if (locator.kind === 'work_item_counts') {
    return locator.query === undefined ? 'work_item_counts' : `work_item_counts:${locator.query}`
  }
  return locator.field === undefined
    ? `work_item:${locator.id}`
    : `work_item:${locator.id}#${locator.field}`
}

/** A work item at one version, in the shape of the product; `null` is «non dedotto». */
export interface WorkItem {
  sourceId: SourceId
  externalId: string
  url: string | null
  summary: string | null
  type: string | null
  state: string | null
  sprint: string | null
  iteration: string | null
  area: string | null
  assignee: string | null
  storyPoints: number | null
  priority: string | null
  created: Date | null
  changed: Date | null
  closed: Date | null
  /** A calendar day `yyyy-mm-dd`. */
  due: string | null
  parent: string | null
  tags: string[]
}

/** One stored version of a work item, as the tracker history gives it. */
export interface StoredWorkItem {
  sourceId: SourceId
  kind: TrackerSourceKind
  externalId: string
  fields: Record<string, unknown>
  url: string | null
}

/** Longest text of a field kept: a label, a path, a title. */
const MAX_FIELD_TEXT = 300
const MAX_TAGS = 20

function textOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const text = canonicalText(v)
  if (text === '') return null
  return [...text].slice(0, MAX_FIELD_TEXT).join('')
}

function numberOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function dateOf(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function dayOf(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  return isCalendarDate(y, m, d) ? v : null
}

function tagsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .flatMap((t) => {
      const tag = textOf(t)
      return tag ? [tag] : []
    })
    .slice(0, MAX_TAGS)
}

/** The last segment of an Azure DevOps path; the root alone (the project) is no sprint. */
function leafOf(path: string | null): string | null {
  if (path === null) return null
  const parts = path.split('\\').filter((p) => p.trim() !== '')
  return parts.length > 1 ? (parts.at(-1) ?? null) : null
}

function priorityOf(v: unknown): string | null {
  const n = numberOf(v)
  return n !== null ? String(n) : textOf(v)
}

/**
 * A stored version in the shape of the product. Azure DevOps: the sprint is the last segment of
 * the iteration path (the root alone is none), no due date; a version stored before the connector
 * read the creation date has none. Jira: the sprint is the active one (else the last), the status
 * is the state, labels are the tags, no iteration nor area. Whatever is missing or not of its type
 * is `null`, never guessed.
 */
export function workItemOf(stored: StoredWorkItem): WorkItem {
  const f = stored.fields
  const base = {
    sourceId: stored.sourceId,
    externalId: stored.externalId,
    url: stored.url,
    summary: textOf(f.title),
    type: textOf(f.type),
    storyPoints: numberOf(f.storyPoints),
    priority: priorityOf(f.priority),
  }
  if (stored.kind === 'ado') {
    const iteration = textOf(f.iterationPath)
    return {
      ...base,
      state: textOf(f.state),
      sprint: leafOf(iteration),
      iteration,
      area: textOf(f.areaPath),
      assignee: textOf(f.assignedTo),
      created: dateOf(f.createdAt),
      changed: dateOf(f.changedAt),
      closed: dateOf(f.closedAt),
      due: null,
      parent: textOf(f.parentId),
      tags: tagsOf(f.tags),
    }
  }
  return {
    ...base,
    state: textOf(f.status),
    sprint: textOf(f.sprint),
    iteration: null,
    area: null,
    assignee: textOf(f.assignee),
    created: dateOf(f.createdAt),
    changed: dateOf(f.updatedAt),
    closed: dateOf(f.resolvedAt),
    due: dayOf(f.dueDate),
    parent: textOf(f.parentKey),
    tags: tagsOf(f.labels),
  }
}

/**
 * The fields a work item can be grouped by. `feature` is not a field: it is the feature the work
 * item stands under, up the chain of its parents (a task under a backlog item under a feature).
 */
export const TRACKER_GROUP_FIELDS = [
  'type',
  'state',
  'sprint',
  'iteration',
  'area',
  'assignee',
  'parent',
  'priority',
  'feature',
] as const
export type TrackerGroupField = (typeof TRACKER_GROUP_FIELDS)[number]

/** The dates a work item can be filtered by. */
export const TRACKER_DATE_FIELDS = ['created', 'changed', 'closed', 'due'] as const
export type TrackerDateField = (typeof TRACKER_DATE_FIELDS)[number]

/** Structured filters only: every list is «any of», every filter given must hold. */
export interface TrackerFilter {
  sourceIds?: readonly SourceId[]
  types?: readonly string[]
  /** Types never counted (none of these), whatever the other filters say. */
  excludedTypes?: readonly string[]
  states?: readonly string[]
  sprints?: readonly string[]
  /** An iteration path, or one above it. */
  iterations?: readonly string[]
  /** An area path, or one above it. */
  areas?: readonly string[]
  assignees?: readonly string[]
  /** Calendar days in Italy, both included; a work item without that date does not match. */
  dates?: { field: TrackerDateField; from?: string; to?: string }
  /** Only the work items without this date («non dedotto»). */
  undated?: TrackerDateField
}

/** Equal ignoring case, accents and spacing. */
function fold(text: string): string {
  return canonicalText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
}

const anyOf = (wanted: readonly string[] | undefined, value: string | null): boolean => {
  if (!wanted || wanted.length === 0) return true
  if (value === null) return false
  const v = fold(value)
  return wanted.some((w) => fold(w) === v)
}

/** The path or one under it: `A\B` holds `A\B` and `A\B\C`, not `A\BC`. */
const underAnyOf = (wanted: readonly string[] | undefined, value: string | null): boolean => {
  if (!wanted || wanted.length === 0) return true
  if (value === null) return false
  const v = fold(value)
  return wanted.some((w) => {
    const p = fold(w).replace(/\\+$/, '')
    return p !== '' && (v === p || v.startsWith(`${p}\\`))
  })
}

/** A calendar day `yyyy-mm-dd`, or null when it is not one. */
export function parseCalendarDay(text: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  return isCalendarDate(y, m, d) ? { y, m, d } : null
}

/** The first instant after a calendar day in Italy (midnight of the day after). */
export function endOfRomeDay(text: string): Date | null {
  const day = parseCalendarDay(text)
  if (!day) return null
  const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1))
  return romeMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
}

function inDates(item: WorkItem, dates: TrackerFilter['dates']): boolean {
  if (!dates) return true
  if (dates.field === 'due') {
    if (item.due === null) return false
    return (!dates.from || item.due >= dates.from) && (!dates.to || item.due <= dates.to)
  }
  const at = item[dates.field]
  if (at === null) return false
  const day = romeDateString(at)
  return (!dates.from || day >= dates.from) && (!dates.to || day <= dates.to)
}

function hasDate(item: WorkItem, field: TrackerDateField): boolean {
  return field === 'due' ? item.due !== null : item[field] !== null
}

/** Whether a work item holds every filter given. */
export function matchesTrackerFilter(item: WorkItem, filter: TrackerFilter): boolean {
  if (
    filter.sourceIds &&
    filter.sourceIds.length > 0 &&
    !filter.sourceIds.includes(item.sourceId)
  ) {
    return false
  }
  if (
    filter.excludedTypes &&
    filter.excludedTypes.length > 0 &&
    item.type !== null &&
    anyOf(filter.excludedTypes, item.type)
  ) {
    return false
  }
  return (
    anyOf(filter.types, item.type) &&
    anyOf(filter.states, item.state) &&
    anyOf(filter.sprints, item.sprint) &&
    underAnyOf(filter.iterations, item.iteration) &&
    underAnyOf(filter.areas, item.area) &&
    anyOf(filter.assignees, item.assignee) &&
    inDates(item, filter.dates) &&
    (filter.undated === undefined || !hasDate(item, filter.undated))
  )
}

export interface TrackerGroup {
  sourceId: SourceId
  /** `null`: the work items without a value for the field («non dedotto»). */
  key: string | null
  count: number
  /** The sum of the story points of the group; `null` when none of them has any. */
  storyPoints: number | null
}

/** Sums without the float noise of decimal story points (0.1 + 0.2). */
const sum = (a: number, b: number) => Math.round((a + b) * 1000) / 1000

/**
 * The counts of the work items by source and by the value of a field, most numerous first. The
 * same value written differently (case, accents, spacing) is one group, named as first seen.
 */
export function groupWorkItems(
  items: readonly WorkItem[],
  by: TrackerGroupField,
  /** Every work item the parents of `items` may be among (by default `items`), for `feature`. */
  all: readonly WorkItem[] = items,
  /** The decisions of the PM along the chain, for `feature`. */
  decisions: FeatureDecisions = {},
): TrackerGroup[] {
  return groupWeighted(
    items.map((item) => ({ item, count: 1 })),
    by,
    by === 'feature' ? featureFinder(all, decisions) : undefined,
  )
}

/** What the PM decided of the work items a chain of parents passes through. */
export interface FeatureDecisions {
  /** A work item the PM attributed: its parent is the feature, nothing is walked past it. */
  attributed?: (item: WorkItem) => boolean
  /** A work item the PM left out: never a feature, the chain goes on from its parent. */
  excluded?: (item: WorkItem) => boolean
}

/** The types a feature has in the trackers: a Feature in Azure DevOps, an Epic in Jira. */
export const FEATURE_TYPES: readonly string[] = ['Feature', 'Epic']

/** Most parents walked up from a work item: past it the chain is broken, or a cycle. */
const MAX_PARENT_DEPTH = 10

/**
 * The feature a work item stands under: itself when it is a feature, else the nearest parent of
 * a feature type up the chain. A work item the PM attributed stands under the parent the PM gave,
 * and so does what is under it: the decision of the PM is final. A work item the PM left out is
 * never the feature: the chain goes on from its parent. When the chain leaves the work items
 * known (a parent not read), that parent; null when the chain ends without a feature («non
 * attribuito»), never a backlog item taken for a feature.
 */
export function featureFinder(
  all: readonly WorkItem[],
  decisions: FeatureDecisions = {},
): (item: WorkItem) => string | null {
  const byKey = new Map(all.map((i) => [`${i.sourceId}\u001f${i.externalId}`, i]))
  const isFeature = (i: WorkItem) => i.type !== null && anyOf(FEATURE_TYPES, i.type)
  const attributed = decisions.attributed ?? (() => false)
  const excluded = decisions.excluded ?? (() => false)
  return (item) => {
    if (attributed(item)) return item.parent
    if (isFeature(item)) return item.externalId
    let parent = item.parent
    for (let depth = 0; parent !== null && depth < MAX_PARENT_DEPTH; depth++) {
      const up = byKey.get(`${item.sourceId}\u001f${parent}`)
      if (up === undefined) return parent
      if (attributed(up)) return up.parent
      if (!excluded(up) && isFeature(up)) return parent
      parent = up.parent
    }
    // The chain ends among the work items known without a feature, or never ends.
    return null
  }
}

function groupWeighted(
  entries: ReadonlyArray<{ item: WorkItem; count: number }>,
  by: TrackerGroupField,
  feature?: (item: WorkItem) => string | null,
): TrackerGroup[] {
  const groups = new Map<string, TrackerGroup>()
  for (const { item, count } of entries) {
    const value = by === 'feature' ? (feature ?? featureFinder([item]))(item) : item[by]
    const id = `${item.sourceId}\u001f${value === null ? '\u0000' : fold(value)}`
    let group = groups.get(id)
    if (!group) {
      group = { sourceId: item.sourceId, key: value, count: 0, storyPoints: null }
      groups.set(id, group)
    }
    group.count += count
    if (item.storyPoints !== null) group.storyPoints = sum(group.storyPoints ?? 0, item.storyPoints)
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) ||
      b.count - a.count ||
      (a.key ?? '￿').localeCompare(b.key ?? '￿'),
  )
}

/** Counts storage made of the current work items of a source, by raw state and sprint value. */
export interface CountedRow {
  state: string | null
  /** Azure DevOps: the iteration path; Jira: the sprint. */
  sprint: string | null
  count: number
}

/**
 * Counts made by storage, grouped as the work items themselves would be (same reading of the
 * values, same folding of case and accents): the total, by state and by sprint.
 */
export function groupCountedRows(
  sourceId: SourceId,
  kind: TrackerSourceKind,
  rows: readonly CountedRow[],
): { total: number; byState: TrackerGroup[]; bySprint: TrackerGroup[] } {
  const entries = rows.map((r) => ({
    item: workItemOf({
      sourceId,
      kind,
      externalId: '-',
      url: null,
      fields:
        kind === 'ado'
          ? { state: r.state, iterationPath: r.sprint }
          : { status: r.state, sprint: r.sprint },
    }),
    count: r.count,
  }))
  return {
    total: rows.reduce((n, r) => n + r.count, 0),
    byState: groupWeighted(entries, 'state'),
    bySprint: groupWeighted(entries, 'sprint'),
  }
}

/** The totals of the work items of each source: how many and their story points. */
export function totalsOfWorkItems(items: readonly WorkItem[]): Omit<TrackerGroup, 'key'>[] {
  const totals = new Map<SourceId, Omit<TrackerGroup, 'key'>>()
  for (const item of items) {
    let total = totals.get(item.sourceId)
    if (!total) {
      total = { sourceId: item.sourceId, count: 0, storyPoints: null }
      totals.set(item.sourceId, total)
    }
    total.count += 1
    if (item.storyPoints !== null) total.storyPoints = sum(total.storyPoints ?? 0, item.storyPoints)
  }
  return [...totals.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId))
}

/** Most recently changed first, then by id: the order rows are shown in. */
export function sortWorkItems(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) =>
      (b.changed?.getTime() ?? 0) - (a.changed?.getTime() ?? 0) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.externalId.localeCompare(b.externalId, 'en', { numeric: true }),
  )
}

/** A work item as the model is shown it: texts as they are, dates as days in Italy. */
export interface WorkItemRow {
  summary: string | null
  type: string | null
  state: string | null
  sprint: string | null
  iteration: string | null
  area: string | null
  assignee: string | null
  story_points: number | null
  priority: string | null
  created: string | null
  changed: string | null
  closed: string | null
  due: string | null
  parent: string | null
  tags: string[]
}

const day = (d: Date | null) => (d === null ? null : romeDateString(d))

export function workItemRow(item: WorkItem): WorkItemRow {
  return {
    summary: item.summary,
    type: item.type,
    state: item.state,
    sprint: item.sprint,
    iteration: item.iteration,
    area: item.area,
    assignee: item.assignee,
    story_points: item.storyPoints,
    priority: item.priority,
    created: day(item.created),
    changed: day(item.changed),
    closed: day(item.closed),
    due: item.due,
    parent: item.parent,
    tags: item.tags,
  }
}

/** The text of a field as shown, for its numbers; numbers in the Italian way. */
function fieldText(value: WorkItemRow[WorkItemField]): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.join(' ')
  if (typeof value === 'number') return String(value).replace('.', ',')
  return value
}

/** What a work item shown to the model counts as read: its numbers, in all and per field. */
export function workItemReads(
  externalId: string,
  row: WorkItemRow,
  lang: Lang,
): Array<{ locator: TrackerLocator; numbers: string[] }> {
  const idNumbers = shownNumbersIn(canonicalText(externalId), lang)
  const perField = WORK_ITEM_FIELDS.map((field) => ({
    locator: { kind: 'work_item', id: externalId, field } as TrackerLocator,
    numbers: [...idNumbers, ...shownNumbersIn(canonicalText(fieldText(row[field])), lang)],
  }))
  const all = [...new Set(perField.flatMap((r) => r.numbers))]
  return [{ locator: { kind: 'work_item', id: externalId }, numbers: all }, ...perField]
}

/** The numbers of counts shown to the model: each count and sum of story points. */
/**
 * The ways a calendar day may be written in a sentence (`2026-10-01`, `01/10/2026`, `1/10/2026`,
 * `1 ottobre 2026`, `1° ottobre 2026`, `1 ottobre`): a whole label, never loose numbers. Forms of
 * digits only always carry the year (`01/10` could be a fraction or a count).
 */
export function dayForms(day: string, lang: Lang): { withYear: string[]; yearless: string[] } {
  const parsed = parseCalendarDay(day)
  if (!parsed) return { withYear: [], yearless: [] }
  const dd = String(parsed.d).padStart(2, '0')
  const mm = String(parsed.m).padStart(2, '0')
  const month = vocabulary(lang).FULL_MONTHS[parsed.m - 1] ?? ''
  return {
    withYear: [
      day,
      `${dd}/${mm}/${parsed.y}`,
      `${parsed.d}/${parsed.m}/${parsed.y}`,
      `${parsed.d} ${month} ${parsed.y}`,
      `${dd} ${month} ${parsed.y}`,
      `${parsed.d}° ${month} ${parsed.y}`,
    ],
    yearless: [`${parsed.d} ${month}`, `${parsed.d}° ${month}`],
  }
}

/** Every form of `dayForms`, with the year and without. */
export function dayLabels(day: string, lang: Lang): string[] {
  const { withYear, yearless } = dayForms(day, lang)
  return [...withYear, ...yearless]
}

/**
 * The health of a tracker source as its age is judged: a source never synced to the end has no
 * known age; otherwise its data is as old as the older of what the connector says and its last
 * completed sync, or as that sync while a run is left with more to read.
 */
export function trackerDataAsOf(health: {
  pending: boolean
  lastSuccessAt: Date | null
  dataAsOf: Date | null
}): Date | null {
  const { pending, lastSuccessAt, dataAsOf } = health
  if (lastSuccessAt === null) return null
  if (pending || dataAsOf === null) return lastSuccessAt
  return dataAsOf.getTime() < lastSuccessAt.getTime() ? dataAsOf : lastSuccessAt
}

export function countNumbers(groups: readonly Omit<TrackerGroup, 'key'>[], lang: Lang): string[] {
  const numbers = groups.flatMap((g) => [
    String(g.count),
    ...(g.storyPoints === null ? [] : [String(g.storyPoints).replace('.', ',')]),
  ])
  return [...new Set(numbers.flatMap((n) => shownNumbersIn(n, lang)))]
}

/** The texts of a row the detector reads: what came from the source as free words. */
const TEXT_FIELDS = [
  'summary',
  'type',
  'state',
  'sprint',
  'iteration',
  'area',
  'assignee',
  'priority',
  'parent',
] as const

/**
 * The suspicious-instruction patterns found in the texts of a row (the tags included), by field:
 * pattern names only, never the text. The row is still data, shown as such.
 */
export function suspiciousFieldsOf(
  row: WorkItemRow,
  lang: Lang,
): Array<{ field: WorkItemField; patterns: SuspiciousPattern[] }> {
  const texts: Array<{ field: WorkItemField; text: string }> = [
    ...TEXT_FIELDS.flatMap((field) => {
      const text = row[field]
      return text === null ? [] : [{ field, text }]
    }),
    ...(row.tags.length > 0 ? [{ field: 'tags' as const, text: row.tags.join('\n') }] : []),
  ]
  const hits = detectSuspicious(texts, lang)
  const out = new Map<WorkItemField, SuspiciousPattern[]>()
  for (const hit of hits) {
    const field = texts[hit.chunkIndex]?.field
    if (!field) continue
    out.set(field, [...(out.get(field) ?? []), hit.pattern])
  }
  return [...out].map(([field, patterns]) => ({ field, patterns }))
}
