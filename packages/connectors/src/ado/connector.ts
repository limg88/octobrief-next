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
  type AdoConfig,
  type AdoEndpoint,
  adoRules,
  apiUrl,
  parseAdoConfig,
  publicEndpoint,
} from './config.ts'
import {
  exportCsv,
  exportTitle,
  recordOf,
  WORK_ITEM_FIELDS,
  type WorkItem,
  workItemOf,
} from './items.ts'
import { listQuery, syncQuery } from './wiql.ts'

/** Where a sync is in the order of the query: the change date and id of the last item read. */
export type AdoCursor = { changedAt: string; id: number } | null

/** Work items per `workitemsbatch` call: the most Azure DevOps reads at once. */
export const BATCH_SIZE = 200
/** Ids per WIQL query (Azure DevOps answers at most 20,000); the next batch queries again. */
export const WIQL_TOP = 5_000
/** Pages of the project list read at most. */
const MAX_PROJECT_PAGES = 50
/** Depth of the area and iteration trees read (Azure DevOps allows 14 levels). */
const NODE_DEPTH = 14

export interface AdoConnectorOptions {
  /** Where the API of a configuration is; the public Azure DevOps hosts by default. */
  endpoint?: (config: AdoConfig) => AdoEndpoint
}

interface Node {
  optionId: string
  label: string
  parentId?: string
  /** The path as work items carry it (`Project\Area\Sub`), in NFC. */
  path: string
  structure: 'area' | 'iteration'
}

/**
 * One call to Azure DevOps through the safe client, with the token in the Authorization header
 * (Basic, empty user). A 203 is the sign-in page Azure DevOps shows to a token it does not take.
 */
async function call(
  ctx: ConnectorContext<AdoConfig>,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ json: unknown; headers: Headers }> {
  const res = await sendJson(ctx.http, method, url, basicAuthorization('', ctx.secret), body)
  if (res.status === 203) throw new ConnectorError('source_auth_failed')
  return { json: res.json(), headers: res.headers }
}

/** The area and iteration trees of the project, flattened, with the paths work items carry. */
function nodesOf(raw: unknown): Node[] {
  if (!isRecord(raw) || !Array.isArray(raw.value)) return bad()
  const nodes: Node[] = []
  const walk = (node: unknown, parent: Node | null, depth: number) => {
    if (!isRecord(node) || depth > NODE_DEPTH + 1) return bad()
    const { id, name, structureType } = node
    if (typeof id !== 'number' || typeof name !== 'string' || name === '') return bad()
    if (structureType !== 'area' && structureType !== 'iteration') return bad()
    const label = name.normalize('NFC')
    const self: Node = {
      optionId: `${structureType}:${id}`,
      label,
      ...(parent ? { parentId: parent.optionId } : {}),
      path: parent ? `${parent.path}\\${label}` : label,
      structure: structureType,
    }
    nodes.push(self)
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) return bad()
      for (const child of node.children) walk(child, self, depth + 1)
    }
  }
  for (const root of raw.value) walk(root, null, 0)
  return nodes
}

/** Whether a work item's path is the node's path or under it (Azure DevOps ignores case). */
function under(itemPath: string, nodePath: string): boolean {
  const item = itemPath.normalize('NFC').toLowerCase()
  const node = nodePath.toLowerCase()
  return item === node || item.startsWith(`${node}\\`)
}

/** The deepest chosen node the path is under, or null. */
function coverOf(path: string, chosen: readonly Node[]): Node | null {
  let best: Node | null = null
  for (const node of chosen) {
    if (under(path, node.path) && (best === null || node.path.length > best.path.length)) {
      best = node
    }
  }
  return best
}

function parseCursor(raw: unknown): AdoCursor {
  if (raw === null) return null
  if (!isRecord(raw)) throw new TypeError('ado cursor')
  const { changedAt, id } = raw
  if (
    typeof changedAt !== 'string' ||
    Number.isNaN(Date.parse(changedAt)) ||
    typeof id !== 'number' ||
    !Number.isInteger(id) ||
    id <= 0
  ) {
    throw new TypeError('ado cursor')
  }
  return { changedAt, id }
}

/**
 * The read-only Azure DevOps connector. A source is one project of one organization; the PM
 * chooses areas and iterations from the project's trees (an item must be under a chosen area
 * and, when iterations are chosen too, under a chosen iteration). A sync asks WIQL for the ids
 * under the chosen paths changed since the cursor, oldest change first, reads them with
 * `workitemsbatch` in groups of 200 as of the query's time, and gives one tracker record per
 * work item plus, when it read any, an «Export ADO del gg/mm hh:mm» of them (a backlog export,
 * system data). What the system returns outside the perimeter is read past and dropped.
 */
export function createAdoConnector(
  options: AdoConnectorOptions = {},
): Connector<AdoConfig, AdoCursor> {
  const endpointOf = options.endpoint ?? publicEndpoint

  const projectIdOf = (cfg: AdoConfig): string => {
    if (cfg.projectId === null) throw new ConnectorError('source_not_configured')
    return cfg.projectId
  }

  async function readNodes(ctx: ConnectorContext<AdoConfig>): Promise<Node[]> {
    const endpoint = endpointOf(ctx.config)
    const project = projectIdOf(ctx.config)
    const { json } = await call(
      ctx,
      'GET',
      apiUrl(endpoint, [project, '_apis', 'wit', 'classificationnodes'], {
        $depth: String(NODE_DEPTH),
      }),
    )
    return nodesOf(json)
  }

  async function listProjects(ctx: ConnectorContext<AdoConfig>): Promise<PerimeterOption[]> {
    const endpoint = endpointOf(ctx.config)
    const options: PerimeterOption[] = []
    let token: string | null = null
    for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
      const { json, headers }: { json: unknown; headers: Headers } = await call(
        ctx,
        'GET',
        apiUrl(endpoint, ['_apis', 'projects'], {
          $top: '100',
          ...(token !== null ? { continuationToken: token } : {}),
        }),
      )
      if (!isRecord(json) || !Array.isArray(json.value)) return bad()
      for (const p of json.value) {
        if (!isRecord(p) || typeof p.id !== 'string' || typeof p.name !== 'string') return bad()
        if (p.state !== undefined && p.state !== 'wellFormed') continue
        options.push({ id: `project:${p.id.toLowerCase()}`, label: p.name.normalize('NFC') })
      }
      token = headers.get('x-ms-continuationtoken')
      if (token === null || token === '') return options
    }
    // More projects than a list reads: never a list cut short in silence.
    throw new ConnectorError('response_too_large')
  }

  /** The ids a WIQL query gives, at most `top`, with the instant the answer holds. */
  async function runWiql(
    ctx: ConnectorContext<AdoConfig>,
    query: string,
    top: number,
  ): Promise<{ ids: number[]; asOf: Date }> {
    const endpoint = endpointOf(ctx.config)
    const { json } = await call(
      ctx,
      'POST',
      apiUrl(endpoint, [projectIdOf(ctx.config), '_apis', 'wit', 'wiql'], {
        timePrecision: 'true',
        $top: String(top),
      }),
      { query },
    )
    if (!isRecord(json) || !Array.isArray(json.workItems)) return bad()
    const ids = json.workItems.map((w) =>
      isRecord(w) && typeof w.id === 'number' && Number.isInteger(w.id) && w.id > 0 ? w.id : bad(),
    )
    const asOf = typeof json.asOf === 'string' ? new Date(json.asOf) : ctx.now()
    if (Number.isNaN(asOf.getTime()) || ids.length > top) return bad()
    return { ids, asOf }
  }

  function readIds(
    ctx: ConnectorContext<AdoConfig>,
    areas: readonly Node[],
    iterations: readonly Node[],
    since: Date | null,
  ): Promise<{ ids: number[]; asOf: Date }> {
    const query = syncQuery({
      areas: areas.map((n) => n.path),
      iterations: iterations.map((n) => n.path),
      changedSince: since,
    })
    return runWiql(ctx, query, WIQL_TOP)
  }

  /** The chosen areas and iterations of the perimeter, as the project's trees have them now. */
  async function chosenNodes(
    ctx: ConnectorContext<AdoConfig>,
  ): Promise<{ areas: Node[]; iterations: Node[] }> {
    const chosenIds = new Set(ctx.perimeter)
    const nodes = await readNodes(ctx)
    const areas = nodes.filter((n) => n.structure === 'area' && chosenIds.has(n.optionId))
    const iterations = nodes.filter((n) => n.structure === 'iteration' && chosenIds.has(n.optionId))
    if (areas.length === 0 && iterations.length === 0) {
      throw new ConnectorError('source_not_configured')
    }
    // A chosen area or iteration the project no longer has: what is read would be partial.
    if (areas.length + iterations.length < chosenIds.size) {
      throw new ConnectorError('source_not_found')
    }
    return { areas, iterations }
  }

  async function readItems(
    ctx: ConnectorContext<AdoConfig>,
    ids: readonly number[],
    asOf: Date,
  ): Promise<Map<number, WorkItem>> {
    const endpoint = endpointOf(ctx.config)
    const { json } = await call(
      ctx,
      'POST',
      apiUrl(endpoint, [projectIdOf(ctx.config), '_apis', 'wit', 'workitemsbatch']),
      { ids, fields: WORK_ITEM_FIELDS, asOf: asOf.toISOString(), errorPolicy: 'omit' },
    )
    if (!isRecord(json) || !Array.isArray(json.value)) return bad()
    const found = new Map<number, WorkItem>()
    // With `errorPolicy: omit`, an item that is gone (deleted, no access) is null.
    for (const raw of json.value) {
      if (raw === null) continue
      const item = workItemOf(raw)
      found.set(item.id, item)
    }
    return found
  }

  return {
    kind: 'ado',
    parseConfig: parseAdoConfig,
    parseCursor,
    rules: (config) => adoRules(endpointOf(config), config),

    async test(ctx): Promise<ConnectorCheck> {
      try {
        const endpoint = endpointOf(ctx.config)
        const url =
          ctx.config.projectId === null
            ? apiUrl(endpoint, ['_apis', 'projects'], { $top: '1' })
            : apiUrl(endpoint, ['_apis', 'projects', ctx.config.projectId])
        await call(ctx, 'GET', url)
        return { ok: true }
      } catch (error) {
        if (error instanceof ConnectorError) return { ok: false, code: error.code }
        throw error
      }
    },

    async perimeterOptions(ctx) {
      // Before a project is chosen the list is of projects; then of its areas and iterations.
      if (ctx.config.projectId === null) return listProjects(ctx)
      return (await readNodes(ctx)).map((n) => ({
        id: n.optionId,
        label: n.label,
        ...(n.parentId !== undefined ? { parentId: n.parentId } : {}),
      }))
    },

    async listIds(ctx) {
      const { areas, iterations } = await chosenNodes(ctx)
      // One query, ids only. A full answer may be cut by the system: it is never taken as all.
      const { ids, asOf } = await runWiql(
        ctx,
        listQuery({ areas: areas.map((n) => n.path), iterations: iterations.map((n) => n.path) }),
        MAX_LISTED_IDS,
      )
      if (ids.length >= MAX_LISTED_IDS) throw new ConnectorError('response_too_large')
      return { ids: [...new Set(ids)].map(String), asOf }
    },

    async sync(ctx, cursor, limits: SyncLimits): Promise<SyncBatch<AdoCursor>> {
      const project = projectIdOf(ctx.config)
      const endpoint = endpointOf(ctx.config)
      const { areas, iterations } = await chosenNodes(ctx)

      const after = cursor === null ? null : { at: Date.parse(cursor.changedAt), id: cursor.id }
      const { ids, asOf } = await readIds(
        ctx,
        areas,
        iterations,
        after === null ? null : new Date(after.at),
      )
      const alreadyRead = (w: WorkItem) =>
        after !== null &&
        (w.changedAt.getTime() < after.at ||
          (w.changedAt.getTime() === after.at && w.id <= after.id))

      // One place of the batch is kept for the export when there is room for it.
      const withExport = limits.maxItems >= 2
      const room = withExport ? limits.maxItems - 1 : limits.maxItems
      const read: WorkItem[] = []
      const items: ExternalItem[] = []
      let position: AdoCursor = cursor
      let examinedAll = true
      // What the query gave and was read past, counted: a read that keeps nothing says why.
      let outsidePerimeter = 0
      let notReadable = 0

      // The cursor is a position in this order: an answer out of it fails the batch.
      const inOrder = orderGuard<{ at: number; id: number }>((a, b) => a.at - b.at || a.id - b.id, {
        strict: true,
      })
      scan: for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const group = ids.slice(i, i + BATCH_SIZE)
        const found = await readItems(ctx, group, asOf)
        for (const id of group) {
          const w = found.get(id)
          if (w === undefined) {
            notReadable += 1
            continue
          }
          inOrder({ at: w.changedAt.getTime(), id: w.id })
          if (alreadyRead(w)) continue
          if (read.length >= room) {
            examinedAll = false
            break scan
          }
          position = { changedAt: w.changedAt.toISOString(), id: w.id }
          const area = areas.length > 0 ? coverOf(w.areaPath, areas) : null
          const iteration = iterations.length > 0 ? coverOf(w.iterationPath, iterations) : null
          // Outside the perimeter: read past (the cursor moves), never kept.
          if (
            (areas.length > 0 && area === null) ||
            (iterations.length > 0 && iteration === null)
          ) {
            outsidePerimeter += 1
            continue
          }
          read.push(w)
          items.push({
            externalId: String(w.id),
            version: String(w.rev),
            title: w.title,
            mediaType: 'application/json',
            record: recordOf(w),
            originAt: w.changedAt,
            author: null,
            url: `${endpoint.origin}/${[
              ...endpoint.prefix,
              project,
              '_workitems',
              'edit',
              String(w.id),
            ]
              .map(encodeURIComponent)
              .join('/')}`,
            perimeter: [area, iteration].flatMap((n) => (n ? [n.optionId] : [])),
            people: uniquePeople([...(w.assignedTo ? [w.assignedTo] : []), ...w.mentioned]),
            ...(w.mentionsRefused ? { peopleIncomplete: true as const } : {}),
          })
        }
      }

      if (withExport && read.length > 0 && position !== null) {
        items.push(
          backlogExport({
            position: `${position.changedAt}:${position.id}`,
            title: exportTitle(asOf),
            csv: exportCsv(read),
            asOf,
            records: items,
          }),
        )
      }

      const skipped = {
        ...(outsidePerimeter > 0 ? { outside_perimeter: outsidePerimeter } : {}),
        ...(notReadable > 0 ? { not_readable: notReadable } : {}),
      }
      return {
        items,
        nextCursor: position,
        done: examinedAll && ids.length < WIQL_TOP,
        dataAsOf: asOf,
        ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
      }
    },
  }
}

/** The connector of the production worker: the public Azure DevOps hosts only. */
export const adoConnector = createAdoConnector()
