import {
  countNumbers,
  DomainError,
  endOfRomeDay,
  groupWorkItems,
  type KnownPerson,
  type Lang,
  MAX_TRACKER_ITEMS_SCANNED,
  matchesTrackerFilter,
  type ProjectId,
  Pseudonymizer,
  parseCalendarDay,
  type ReadLogWriter,
  sortWorkItems,
  suspiciousFieldsOf,
  TRACKER_DATE_FIELDS,
  TRACKER_GROUP_FIELDS,
  type TrackerFilter,
  type TrackerGroup,
  type TrackerLocator,
  type TrackerReader,
  type TrackerSourceView,
  totalsOfWorkItems,
  trackerQueryId,
  workItemOf,
  workItemReads,
  workItemRow,
} from '@octobrief/domain'
import { z } from 'zod'
import { peopleMatcherFor } from '../model/people-matchers.ts'
import type { Tool } from './tool-loop.ts'

/** Work items returned by one `query_tracker` call; the rest is paged with `offset`. */
export const MAX_TRACKER_ROWS = 25
/** Groups returned by one call: the most numerous. */
export const MAX_TRACKER_GROUPS = 50
/** Characters of one result at most: rows, then groups, are dropped from the end until it fits. */
export const MAX_TRACKER_OUTPUT_CHARS = 24_000

const MAX_VALUES = 20
const MAX_VALUE_LENGTH = 300
const MAX_SOURCES = 10

const values = z
  .array(z.string().trim().min(1).max(MAX_VALUE_LENGTH))
  .min(1)
  .max(MAX_VALUES)
  .optional()
const calendarDay = z.string().refine((s) => parseCalendarDay(s) !== null)

const queryArgs = z
  .strictObject({
    source_ids: z.array(z.uuid()).min(1).max(MAX_SOURCES).optional(),
    types: values,
    states: values,
    sprints: values,
    iterations: values,
    areas: values,
    assignees: values,
    date_field: z.enum(TRACKER_DATE_FIELDS).optional(),
    date_from: calendarDay.optional(),
    date_to: calendarDay.optional(),
    as_of: calendarDay.optional(),
    group_by: z.enum(TRACKER_GROUP_FIELDS).optional(),
    offset: z.number().int().min(0).max(MAX_TRACKER_ITEMS_SCANNED).optional(),
  })
  .refine((a) => (a.date_from === undefined && a.date_to === undefined) || a.date_field)
  .refine((a) => !a.date_from || !a.date_to || a.date_from <= a.date_to)

type QueryArgs = z.infer<typeof queryArgs>

const INVALID = JSON.stringify({ error: 'invalid_arguments' })
const NOT_FOUND = JSON.stringify({ error: 'not_found' })
const NO_TRACKER = JSON.stringify({ error: 'no_tracker_sources' })
const TOO_MANY = JSON.stringify({ error: 'too_many_work_items' })
/** The names of a result could not all be hidden from the model: nothing of it is returned. */
const NOT_PSEUDONYMIZED = JSON.stringify({ error: 'pseudonymization_unavailable' })

const TOKEN = /\[(?:PERSONA|EMAIL|TELEFONO|LITERAL)_\d+[A-Z]*\]/gu

/**
 * How a tracker source can answer a call: `ok`; `not_synced` before its first completed sync
 * (nothing of it is known for sure); `history_not_available` for a day before its history starts
 * (its first completed sync). Only an `ok` source gives counts and work items.
 */
export type TrackerSourceStatus = 'ok' | 'not_synced' | 'history_not_available'

export function trackerSourceStatus(
  source: Pick<TrackerSourceView, 'lastSuccessAt' | 'firstSuccessAt'>,
  at: Date | null,
): TrackerSourceStatus {
  if (source.lastSuccessAt === null) return 'not_synced'
  if (at === null) return 'ok'
  const from = source.firstSuccessAt ?? source.lastSuccessAt
  return at.getTime() < from.getTime() ? 'history_not_available' : 'ok'
}

export interface TrackerToolDeps<Tx> {
  projectId: ProjectId
  lang: Lang
  log: ReadLogWriter
  tracker: TrackerReader<Tx>
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  now: Date
  /**
   * The number of the next call, when several tracker tools write to the same read log: one
   * counter for all of them, so the locator of a call (`q1`, `q2`…) names one call only.
   */
  nextCall?: () => number
}

/** A counter of the calls of the tracker tools that share one read log. */
export function trackerCallCounter(): () => number {
  let calls = 0
  return () => {
    calls += 1
    return calls
  }
}

function filterOf(args: QueryArgs): TrackerFilter {
  return {
    ...(args.types ? { types: args.types } : {}),
    ...(args.states ? { states: args.states } : {}),
    ...(args.sprints ? { sprints: args.sprints } : {}),
    ...(args.iterations ? { iterations: args.iterations } : {}),
    ...(args.areas ? { areas: args.areas } : {}),
    ...(args.assignees ? { assignees: args.assignees } : {}),
    ...(args.date_field
      ? {
          dates: {
            field: args.date_field,
            ...(args.date_from ? { from: args.date_from } : {}),
            ...(args.date_to ? { to: args.date_to } : {}),
          },
        }
      : {}),
  }
}

/** Every string of a JSON value (keys too), as the model runner pseudonymizes them. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      stringsOf(v, out)
    }
  }
  return out
}

/**
 * Whether a result would leave a name in clear once the model runner, built from these people,
 * pseudonymized it: each name must be hidden on its own (every letter of it in a token) and no
 * string of the result, as the runner reads it, may still hold one.
 */
function leaksNames(
  projectId: ProjectId,
  people: readonly KnownPerson[],
  names: readonly string[],
  result: unknown,
): boolean {
  if (names.length === 0) return false
  const p = new Pseudonymizer(peopleMatcherFor(projectId, people))
  if (names.some((n) => /[\p{L}\p{N}]/u.test(p.pseudonymize(n).replace(TOKEN, '')))) return true
  const patterns = [...new Set(names.map((n) => n.normalize('NFC')))].map(
    (n) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'iu',
      ),
  )
  return stringsOf(result).some((s) => {
    const out = p.pseudonymize(s)
    return patterns.some((re) => re.test(out))
  })
}

/**
 * The structured tracker tool of the model: the work items of the tracker sources of the project
 * (Azure DevOps, Jira), current now or at the end of a day, filtered by fields only (never free
 * text), with the totals and, if asked, the counts by a field. Each row and the counts of each
 * call (`counts_locator`, with the id of the call in the run) carry the citation the model gives
 * back. Only what the tool computed from the history is written to the read log: counts, story
 * points, ids and dates of the rows; never a number of the arguments. Group names and the day
 * asked are labels, whose digits are no number.
 *
 * A source never synced to the end, or asked for a day before its history starts, gives nothing
 * (its status says why). Texts are data: a text that reads like an instruction is flagged by
 * pattern name, not hidden. Names of people go out only if the model runner's pseudonymizer
 * hides them (the same people); otherwise the call returns an error and nothing of the result.
 */
export function trackerTool<Tx>(deps: TrackerToolDeps<Tx>): Tool {
  const { projectId, lang, log, tracker, withTx } = deps
  const nextCall = deps.nextCall ?? trackerCallCounter()
  return {
    spec: {
      name: 'query_tracker',
      description:
        'Reads the work items of the project trackers (Azure DevOps, Jira) by structured filters, never by words: type, state, sprint, iteration, area, assignee, dates. Gives the totals, the counts by a field (group_by) and up to 25 work items at a time, each with the locator to cite; the counts of each call have their own counts_locator.',
      parameters: {
        type: 'object',
        properties: {
          source_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these trackers (source_id); all of them by default',
          },
          types: { type: 'array', items: { type: 'string' }, description: 'Work item types' },
          states: { type: 'array', items: { type: 'string' }, description: 'States' },
          sprints: { type: 'array', items: { type: 'string' }, description: 'Sprints' },
          iterations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Iteration paths (and those under them)',
          },
          areas: {
            type: 'array',
            items: { type: 'string' },
            description: 'Area paths (and those under them)',
          },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Assignees, written exactly as the tool returned them',
          },
          date_field: {
            type: 'string',
            enum: [...TRACKER_DATE_FIELDS],
            description:
              'The date filtered by: created (when the work item was created), changed, closed, due. A work item without that date never matches',
          },
          date_from: { type: 'string', description: 'First day, yyyy-mm-dd, with date_field' },
          date_to: { type: 'string', description: 'Last day, yyyy-mm-dd, with date_field' },
          as_of: {
            type: 'string',
            description: 'The work items as they were at the end of this day, yyyy-mm-dd',
          },
          group_by: { type: 'string', enum: [...TRACKER_GROUP_FIELDS] },
          offset: { type: 'integer', description: 'Work items to skip, as given by next_offset' },
        },
        additionalProperties: false,
      },
    },
    async execute(raw) {
      const parsed = queryArgs.safeParse(raw ?? {})
      if (!parsed.success) return INVALID
      const args = parsed.data
      const at = args.as_of ? endOfRomeDay(args.as_of) : null
      // A day not over yet is the state now.
      const asOf = at !== null && at.getTime() <= deps.now.getTime() ? at : null

      let loaded: {
        sources: Array<{ view: TrackerSourceView; status: TrackerSourceStatus }>
        stored: Awaited<ReturnType<TrackerReader<Tx>['items']>>
        people: KnownPerson[]
      } | null
      try {
        loaded = await withTx(async (tx) => {
          const all = await tracker.sources(tx, projectId)
          const wanted = args.source_ids
            ? all.filter((s) => args.source_ids?.includes(s.sourceId))
            : all
          if (args.source_ids && wanted.length !== new Set(args.source_ids).size) return null
          const sources = wanted.map((view) => ({ view, status: trackerSourceStatus(view, asOf) }))
          const readable = sources.filter((s) => s.status === 'ok').map((s) => s.view.sourceId)
          const stored = await tracker.items(tx, projectId, {
            sourceIds: readable,
            at: asOf,
            limit: MAX_TRACKER_ITEMS_SCANNED + 1,
          })
          // Without a tracker nothing is shown: the people are not needed.
          const people = sources.length === 0 ? [] : await tracker.people(tx, projectId)
          return { sources, stored, people }
        })
      } catch (error) {
        if (error instanceof DomainError && error.code === 'pseudonymization_unavailable') {
          return NOT_PSEUDONYMIZED
        }
        throw error
      }
      if (loaded === null) return NOT_FOUND
      if (loaded.sources.length === 0) return NO_TRACKER
      if (loaded.stored.length > MAX_TRACKER_ITEMS_SCANNED) return TOO_MANY
      const { sources, people } = loaded
      const ok = sources.filter((s) => s.status === 'ok').map((s) => s.view)
      const isOk = (id: string) => ok.some((s) => s.sourceId === id)
      const items = loaded.stored.filter((i) => isOk(i.sourceId)).map(workItemOf)

      const matched = sortWorkItems(items.filter((i) => matchesTrackerFilter(i, filterOf(args))))
      // Every readable tracker has its total, none matched included.
      const found = totalsOfWorkItems(matched)
      const totals = ok.map(
        (s) =>
          found.find((t) => t.sourceId === s.sourceId) ?? {
            sourceId: s.sourceId,
            count: 0,
            storyPoints: null,
          },
      )
      const allGroups = args.group_by ? groupWorkItems(matched, args.group_by, items) : []
      // The most numerous groups, shown tracker by tracker in the order of the sources.
      const rank = (g: TrackerGroup) => ok.findIndex((s) => s.sourceId === g.sourceId)
      const topGroups = [...allGroups]
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_TRACKER_GROUPS)
        .sort((a, b) => rank(a) - rank(b) || allGroups.indexOf(a) - allGroups.indexOf(b))

      const offset = args.offset ?? 0
      const page = matched.slice(offset, offset + MAX_TRACKER_ROWS)
      const counts: TrackerLocator = {
        kind: 'work_item_counts',
        query: trackerQueryId(nextCall()),
      }
      // The day asked is echoed only when some tracker has the history of it.
      const dayShown = asOf !== null && ok.length > 0 && args.as_of ? args.as_of : null

      const rows = page.map((item) => {
        const row = workItemRow(item)
        const suspicious = suspiciousFieldsOf(row, lang)
        return {
          item,
          row,
          shown: {
            source_id: item.sourceId,
            locator: { kind: 'work_item', id: item.externalId },
            ...row,
            ...(suspicious.length > 0 ? { suspicious } : {}),
          },
        }
      })
      const result = (keptRows: number, keptGroups: number) => {
        const shownRows = rows.slice(0, keptRows)
        const more = offset + shownRows.length < matched.length
        const groups = topGroups.slice(0, keptGroups)
        return {
          sources: sources.map((s) => ({
            source_id: s.view.sourceId,
            name: s.view.label,
            kind: s.view.kind,
            status: s.status,
          })),
          as_of: dayShown,
          counts_locator: counts,
          totals: totals.map((t) => ({
            source_id: t.sourceId,
            count: t.count,
            story_points: t.storyPoints,
          })),
          ...(args.group_by
            ? {
                group_by: args.group_by,
                groups: groups.map((g) => ({
                  source_id: g.sourceId,
                  value: g.key,
                  count: g.count,
                  story_points: g.storyPoints,
                })),
                groups_truncated: allGroups.length > groups.length,
              }
            : {}),
          work_items: shownRows.map((r) => r.shown),
          offset,
          truncated: more,
          ...(more ? { next_offset: offset + shownRows.length } : {}),
        }
      }
      let keptRows = rows.length
      let keptGroups = topGroups.length
      let shown = result(keptRows, keptGroups)
      let text = JSON.stringify(shown)
      while (text.length > MAX_TRACKER_OUTPUT_CHARS && (keptRows > 0 || keptGroups > 0)) {
        if (keptRows > 0) keptRows -= 1
        else keptGroups -= 1
        shown = result(keptRows, keptGroups)
        text = JSON.stringify(shown)
      }
      const groups = topGroups.slice(0, keptGroups)

      // Fail closed: a name the runner would not hide never goes out.
      const names = [
        ...rows.slice(0, keptRows).map((r) => r.item.assignee),
        ...(args.group_by === 'assignee' ? groups.map((g) => g.key) : []),
      ].filter((n): n is string => n !== null)
      // The people that cannot all be hidden: nothing goes out either.
      try {
        if (leaksNames(projectId, people, names, shown)) return NOT_PSEUDONYMIZED
      } catch (error) {
        if (error instanceof DomainError && error.code === 'pseudonymization_unavailable') {
          return NOT_PSEUDONYMIZED
        }
        throw error
      }

      // What was shown, and only that, counts as read.
      for (const r of rows.slice(0, keptRows)) {
        log.recordTracker(r.item.sourceId, workItemReads(r.item.externalId, r.row, lang))
      }
      const days = dayShown ? [dayShown] : []
      for (const source of ok) {
        const mine = <G extends { sourceId: string }>(g: G) => g.sourceId === source.sourceId
        const shownCounts: Array<Omit<TrackerGroup, 'key'>> = [
          ...totals.filter(mine),
          ...groups.filter(mine),
        ]
        const keys = groups.filter(mine).flatMap((g) => (g.key ? [g.key] : []))
        log.recordTracker(source.sourceId, [
          { locator: counts, numbers: countNumbers(shownCounts, lang), labels: keys, days },
        ])
      }
      return text
    },
  }
}
