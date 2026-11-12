import { ConnectorError } from '../errors.ts'
import {
  type Connector,
  type ConnectorCheck,
  type ConnectorContext,
  type ExternalItem,
  MAX_LISTED_IDS,
  type PerimeterOption,
  type SyncBatch,
  type SyncLimits,
} from '../port.ts'
import { backlogExport } from '../shared/export.ts'
import { basicAuthorization, sendJson } from '../shared/http.ts'
import { orderGuard } from '../shared/order.ts'
import { bad, isRecord, uniquePeople } from '../shared/values.ts'
import {
  apiUrl,
  type JiraConfig,
  type JiraEndpoint,
  jiraRules,
  parseJiraConfig,
  publicEndpoint,
} from './config.ts'
import {
  commentsCut,
  exportCsv,
  exportTitle,
  type Issue,
  issueFields,
  issueOf,
  lastComments,
  MAX_COMMENTS,
  recordOf,
} from './issues.ts'
import { jqlSince, listJql, syncJql } from './jql.ts'

/**
 * Where a sync is in the order of the search: the update instant of the last issue read and
 * the ids of every issue read at that very instant. Jira orders ties by key, which the
 * connector does not rebuild: the set makes a tie split across batches safe in any order.
 */
export type JiraCursor = { updated: string; ids: string[] } | null

/** Issues per search page: the most Jira gives with fields. */
export const PAGE_SIZE = 100
/** Search pages read in one batch at most. */
export const MAX_SEARCH_PAGES = 50
/**
 * How long an issue may take to show in the search after it changed: Jira's search index is
 * eventually consistent. A sync reads only what changed before this window, so that an issue
 * indexed late is never passed by the cursor.
 */
export const SETTLE_MS = 10 * 60 * 1000
/** Issues changed at the same millisecond the cursor can hold. */
export const MAX_TIES = 1_000
/** Pages of the project list read at most. */
const MAX_PROJECT_PAGES = 50
/** Project ids per lookup (Jira reads at most 50). */
const PROJECT_LOOKUP = 50

export interface JiraConnectorOptions {
  /** Where the API of a configuration is; the public Atlassian hosts by default. */
  endpoint?: (config: JiraConfig) => JiraEndpoint
}

const PROJECT_OPTION = /^project:(\d{1,18})$/

async function getJson(ctx: ConnectorContext<JiraConfig>, url: string): Promise<unknown> {
  const res = await sendJson(ctx.http, 'GET', url, basicAuthorization(ctx.config.email, ctx.secret))
  return res.json()
}

function parseCursor(raw: unknown): JiraCursor {
  if (raw === null) return null
  if (!isRecord(raw)) throw new TypeError('jira cursor')
  const { updated, ids } = raw
  if (
    typeof updated !== 'string' ||
    Number.isNaN(Date.parse(updated)) ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_TIES ||
    !ids.every((id) => typeof id === 'string' && /^\d{1,18}$/.test(id))
  ) {
    throw new TypeError('jira cursor')
  }
  return { updated, ids: [...ids] as string[] }
}

interface Project {
  id: string
  key: string
  name: string
}

function projectsOf(json: unknown): { projects: Project[]; isLast: boolean } {
  if (!isRecord(json) || !Array.isArray(json.values)) return bad()
  const projects = json.values.map((p): Project => {
    if (
      !isRecord(p) ||
      typeof p.id !== 'string' ||
      !/^\d{1,18}$/.test(p.id) ||
      typeof p.key !== 'string' ||
      typeof p.name !== 'string'
    ) {
      return bad()
    }
    return { id: p.id, key: p.key.normalize('NFC'), name: p.name.normalize('NFC') }
  })
  return { projects, isLast: json.isLast !== false }
}

/**
 * The read-only Jira Cloud connector. A source is a site; the PM chooses projects from its list
 * (ids, which stay when a key is renamed). A sync searches the issues of the chosen projects
 * changed since the cursor, oldest change first, page by page with `nextPageToken`, reading the
 * declared fields only (never worklog nor time tracking) and the last 50 comments, and gives one
 * tracker record per issue plus, when it read any, an «Export Jira del gg/mm hh:mm» of them (a
 * backlog export, system data). What the system returns outside the perimeter is read past and
 * dropped. What changed in the last `SETTLE_MS` is left to the next sync (the search index is
 * eventually consistent), and the data is said to be as of the start of that window.
 */
export function createJiraConnector(
  options: JiraConnectorOptions = {},
): Connector<JiraConfig, JiraCursor> {
  const endpointOf = options.endpoint ?? publicEndpoint

  /** The projects of a project search, page by page; more pages than are read fail. */
  async function readProjects(
    ctx: ConnectorContext<JiraConfig>,
    query: [string, string][],
    pages: number,
  ): Promise<Project[]> {
    const endpoint = endpointOf(ctx.config)
    const found: Project[] = []
    for (let page = 0; page < pages; page += 1) {
      const json = await getJson(
        ctx,
        apiUrl(
          endpoint,
          ['project', 'search'],
          [
            ['startAt', String(found.length)],
            ['maxResults', String(PROJECT_LOOKUP)],
            ['orderBy', 'key'],
            ...query,
          ],
        ),
      )
      const { projects, isLast } = projectsOf(json)
      found.push(...projects)
      if (isLast || projects.length === 0) return found
    }
    // More projects than a list reads: never a list cut short in silence.
    throw new ConnectorError('response_too_large')
  }

  async function listProjects(ctx: ConnectorContext<JiraConfig>): Promise<PerimeterOption[]> {
    const projects = await readProjects(ctx, [], MAX_PROJECT_PAGES)
    return projects.map((p) => ({ id: `project:${p.id}`, label: `${p.name} (${p.key})` }))
  }

  /** The chosen projects that still exist, read again at every batch. */
  async function chosenProjects(ctx: ConnectorContext<JiraConfig>): Promise<Map<string, Project>> {
    const ids = [
      ...new Set(ctx.perimeter.flatMap((p) => PROJECT_OPTION.exec(p)?.slice(1, 2) ?? [])),
    ]
    const found = new Map<string, Project>()
    for (let i = 0; i < ids.length; i += PROJECT_LOOKUP) {
      const group = ids.slice(i, i + PROJECT_LOOKUP)
      const query = group.map((id): [string, string] => ['id', id])
      for (const p of await readProjects(ctx, query, PROJECT_LOOKUP)) {
        if (group.includes(p.id)) found.set(p.id, p)
      }
    }
    if (found.size === 0) throw new ConnectorError('source_not_configured')
    // A chosen project the site no longer gives: what is read would be partial.
    if (found.size < ids.length || ids.length < new Set(ctx.perimeter).size) {
      throw new ConnectorError('source_not_found')
    }
    return found
  }

  /** The last comments of an issue, when the search did not give them all. */
  async function readComments(ctx: ConnectorContext<JiraConfig>, issue: Issue): Promise<Issue> {
    const json = await getJson(
      ctx,
      apiUrl(
        endpointOf(ctx.config),
        ['issue', issue.id, 'comment'],
        [
          ['orderBy', '-created'],
          ['maxResults', String(MAX_COMMENTS)],
        ],
      ),
    )
    if (!isRecord(json) || !Array.isArray(json.comments)) return bad()
    return { ...issue, comments: lastComments(json.comments.slice(0, MAX_COMMENTS)) }
  }

  return {
    kind: 'jira',
    parseConfig: parseJiraConfig,
    parseCursor,
    rules: (config) => jiraRules(endpointOf(config)),

    async test(ctx): Promise<ConnectorCheck> {
      try {
        await getJson(ctx, apiUrl(endpointOf(ctx.config), ['myself']))
        return { ok: true }
      } catch (error) {
        if (error instanceof ConnectorError) return { ok: false, code: error.code }
        throw error
      }
    },

    perimeterOptions: listProjects,

    async listIds(ctx) {
      const endpoint = endpointOf(ctx.config)
      const projects = await chosenProjects(ctx)
      const asOf = ctx.now()
      const jql = listJql([...projects.keys()].sort())
      const ids = new Set<string>()
      let token: string | null = null
      // Ids only, page by page: more than a listing holds fails, never a list cut short.
      for (let page = 0; page <= MAX_LISTED_IDS / PAGE_SIZE; page += 1) {
        const json: unknown = await getJson(
          ctx,
          apiUrl(
            endpoint,
            ['search', 'jql'],
            [
              ['jql', jql],
              ['fields', 'id'],
              ['maxResults', String(PAGE_SIZE)],
              ...(token !== null ? [['nextPageToken', token] as [string, string]] : []),
            ],
          ),
        )
        if (!isRecord(json) || !Array.isArray(json.issues) || json.issues.length > PAGE_SIZE) {
          return bad()
        }
        for (const raw of json.issues) {
          if (!isRecord(raw) || typeof raw.id !== 'string' || !/^\d{1,18}$/.test(raw.id)) {
            return bad()
          }
          ids.add(raw.id)
        }
        if (ids.size > MAX_LISTED_IDS) throw new ConnectorError('response_too_large')
        const next = typeof json.nextPageToken === 'string' ? json.nextPageToken : ''
        if (json.isLast === true || (json.isLast === undefined && next === '')) {
          return { ids: [...ids], asOf }
        }
        // More pages said, but no way to them: never taken as the end.
        if (next === '') return bad()
        token = next
      }
      throw new ConnectorError('response_too_large')
    },

    async sync(ctx, cursor, limits: SyncLimits): Promise<SyncBatch<JiraCursor>> {
      const endpoint = endpointOf(ctx.config)
      const projects = await chosenProjects(ctx)
      const now = ctx.now()
      // What changed later than this may not be in the search yet: it waits for the next sync.
      const asOf = new Date(now.getTime() - SETTLE_MS)
      const after =
        cursor === null ? null : { at: Date.parse(cursor.updated), ids: new Set(cursor.ids) }
      const jql = syncJql(
        [...projects.keys()].sort(),
        after === null ? null : jqlSince(new Date(after.at), now),
      )
      const fields = issueFields(ctx.config).join(',')
      const alreadyRead = (issue: Issue) => {
        if (after === null) return false
        const at = issue.updatedAt.getTime()
        return at < after.at || (at === after.at && after.ids.has(issue.id))
      }

      // One place of the batch is kept for the export when there is room for it.
      const withExport = limits.maxItems >= 2
      const room = withExport ? limits.maxItems - 1 : limits.maxItems
      const read: Issue[] = []
      const items: ExternalItem[] = []
      let position: JiraCursor = cursor
      let examinedAll = true
      let reachedEnd = false

      // Updates must never go back; ties come in any order, but an issue only once each.
      const inOrder = orderGuard<number>((a, b) => a - b, { strict: false })
      let tie = { at: Number.NaN, ids: new Set<string>() }
      let token: string | null = null
      scan: for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
        const json: unknown = await getJson(
          ctx,
          apiUrl(
            endpoint,
            ['search', 'jql'],
            [
              ['jql', jql],
              ['fields', fields],
              ['maxResults', String(PAGE_SIZE)],
              ...(token !== null ? [['nextPageToken', token] as [string, string]] : []),
            ],
          ),
        )
        if (!isRecord(json) || !Array.isArray(json.issues) || json.issues.length > PAGE_SIZE) {
          return bad()
        }
        for (const raw of json.issues) {
          const issue = issueOf(raw, ctx.config)
          const at = issue.updatedAt.getTime()
          inOrder(at)
          if (at !== tie.at) tie = { at, ids: new Set() }
          if (tie.ids.has(issue.id)) return bad()
          tie.ids.add(issue.id)
          // Changed within the settle window: the end of this sync, the cursor stays before it.
          if (at > asOf.getTime()) {
            reachedEnd = true
            break scan
          }
          if (alreadyRead(issue)) continue
          if (read.length >= room) {
            examinedAll = false
            break scan
          }
          const updated = issue.updatedAt.toISOString()
          position =
            position !== null && Date.parse(position.updated) === at
              ? { updated, ids: [...position.ids, issue.id] }
              : { updated, ids: [issue.id] }
          // More issues at one instant than a cursor holds: the sync stops, never skips.
          if (position.ids.length > MAX_TIES) return bad()
          // Outside the perimeter: read past (the cursor moves), never kept.
          if (!projects.has(issue.projectId)) continue
          const full = commentsCut(issue) ? await readComments(ctx, issue) : issue
          read.push(full)
          items.push({
            externalId: full.id,
            version: full.updatedAt.toISOString(),
            title: full.summary === '' ? full.key : full.summary,
            mediaType: 'application/json',
            record: recordOf(full),
            originAt: full.updatedAt,
            author: null,
            url: `${endpoint.browse}/browse/${encodeURIComponent(full.key)}`,
            perimeter: [`project:${full.projectId}`],
            people: uniquePeople([
              ...(full.assignee ? [full.assignee] : []),
              ...full.mentioned,
              ...full.comments.flatMap((c) => [...(c.author ? [c.author] : []), ...c.mentioned]),
            ]),
            ...(full.mentionsRefused || full.comments.some((c) => c.mentionsRefused)
              ? { peopleIncomplete: true as const }
              : {}),
          })
        }
        const next = typeof json.nextPageToken === 'string' ? json.nextPageToken : ''
        if (json.isLast === true || (json.isLast === undefined && next === '')) {
          reachedEnd = true
          break
        }
        // More pages said, but no way to them: never taken as the end.
        if (next === '') return bad()
        token = next
      }
      // Every page of a batch spent on what was read already: the cursor cannot move.
      if (!reachedEnd && examinedAll && position === cursor) return bad()

      if (withExport && read.length > 0 && position !== null) {
        items.push(
          backlogExport({
            position: `${position.updated}:${position.ids.at(-1)}`,
            title: exportTitle(asOf),
            csv: exportCsv(read),
            asOf,
            records: items,
          }),
        )
      }

      return { items, nextCursor: position, done: examinedAll && reachedEnd, dataAsOf: asOf }
    },
  }
}

/** The connector of the production worker: the public Atlassian hosts only. */
export const jiraConnector = createJiraConnector()
