import type { IncomingMessage, ServerResponse } from 'node:http'
import { type FakeServer, json, startFakeServer } from './fake-server.ts'

/**
 * A fake Azure DevOps Services organization on loopback, with the shapes of the REST API 7.1:
 *
 * - `GET /{org}/_apis/projects?$top&continuationToken`: `{ count, value: [{ id, name, state,
 *   visibility, lastUpdateTime, url }] }`, the next page in the `x-ms-continuationtoken` header;
 * - `GET /{org}/_apis/projects/{id}`: one project;
 * - `GET /{org}/{project}/_apis/wit/classificationnodes?$depth`: the area and iteration roots,
 *   `{ count, value: [{ id, identifier, name, structureType, hasChildren, path, children }] }`,
 *   where `path` is `\Project\Area\…` (the structure name in it, unlike the work item paths);
 * - `POST /{org}/{project}/_apis/wit/wiql?timePrecision&$top`, body `{ query }`:
 *   `{ queryType: 'flat', queryResultType: 'workItem', asOf, columns, sortColumns,
 *   workItems: [{ id, url }] }`; the query is read for its `UNDER` and `ChangedDate >=` clauses;
 * - `POST /{org}/{project}/_apis/wit/workitemsbatch`, body `{ ids (≤ 200), fields, asOf,
 *   errorPolicy }`: `{ count, value: [{ id, rev, fields, url } | null] }`, a field without value
 *   left out as Azure DevOps does.
 *
 * The token is checked as Basic `:PAT`: none gives the 203 sign-in page, a wrong one 401.
 * Every request is recorded, with its body.
 */

export interface FakeNode {
  name: string
  children?: FakeNode[]
}

export interface FakeWorkItem {
  id: number
  rev: number
  fields: Record<string, unknown>
}

export interface FakeAdoOptions {
  organization: string
  projectId: string
  projectName: string
  pat: string
  areas: FakeNode[]
  iterations: FakeNode[]
  items: FakeWorkItem[]
  /** More projects in the organization, for the list. */
  otherProjects?: { id: string; name: string; state?: string }[]
  /** Projects per page of the list (the API's `$top` is ignored when smaller). */
  projectPageSize?: number
}

export interface ReceivedBody {
  path: string
  body: unknown
}

export interface FakeAdo {
  server: FakeServer
  options: FakeAdoOptions
  /** Bodies of the POST requests, by path. */
  bodies: ReceivedBody[]
  /** Answers the WIQL query with every item, ignoring the perimeter (a misbehaving system). */
  leakPerimeter: boolean
  /**
   * Orders the WIQL answer by the second of the change only, then by id: items changed within
   * the same second come out of their millisecond order (a misbehaving system).
   */
  orderBySecondOnly: boolean
  /** Paths that answer with this status once. */
  failNext: Map<string, number>
  /** The instant the next query says it ran at. */
  asOf: Date
  /**
   * Ids the WIQL query gives but the batch read answers `null` for, as Azure DevOps does with
   * `errorPolicy: omit` for an item the token cannot read.
   */
  unreadable: Set<number>
}

export const AREA_ROOT_ID = 100
export const ITERATION_ROOT_ID = 500

interface IndexedNode {
  id: number
  name: string
  workItemPath: string
  children: IndexedNode[]
}

function index(
  root: string,
  children: FakeNode[],
  firstId: number,
): { tree: IndexedNode; all: IndexedNode[] } {
  let next = firstId
  const all: IndexedNode[] = []
  const build = (name: string, kids: FakeNode[], parentPath: string | null): IndexedNode => {
    const node: IndexedNode = {
      id: next++,
      name,
      workItemPath: parentPath === null ? name : `${parentPath}\\${name}`,
      children: [],
    }
    all.push(node)
    node.children = kids.map((k) => build(k.name, k.children ?? [], node.workItemPath))
    return node
  }
  return { tree: build(root, children, null), all }
}

/** The id the fake gives a node of the area or iteration tree, by its work item path. */
export function nodeIds(options: FakeAdoOptions): Map<string, string> {
  const ids = new Map<string, string>()
  for (const n of index(options.projectName, options.areas, AREA_ROOT_ID).all) {
    ids.set(`area ${n.workItemPath}`, `area:${n.id}`)
  }
  for (const n of index(options.projectName, options.iterations, ITERATION_ROOT_ID).all) {
    ids.set(`iteration ${n.workItemPath}`, `iteration:${n.id}`)
  }
  return ids
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const chunk of req) parts.push(chunk as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

const underPath = (path: string, node: string) => {
  const p = path.toLowerCase()
  const n = node.toLowerCase()
  return p === n || p.startsWith(`${n}\\`)
}

function literals(query: string, field: string): string[] {
  const re = new RegExp(`\\[${field.replace('.', '\\.')}\\] UNDER '((?:[^']|'')*)'`, 'g')
  return [...query.matchAll(re)].map((m) => (m[1] as string).replaceAll("''", "'"))
}

export async function startFakeAdo(options: FakeAdoOptions): Promise<FakeAdo> {
  const areas = index(options.projectName, options.areas, AREA_ROOT_ID)
  const iterations = index(options.projectName, options.iterations, ITERATION_ROOT_ID)
  const org = options.organization
  const project = options.projectId
  const expected = `Basic ${Buffer.from(`:${options.pat}`).toString('base64')}`
  const projects = [
    { id: project, name: options.projectName, state: 'wellFormed' },
    ...(options.otherProjects ?? []),
  ]

  const fake: FakeAdo = {
    server: undefined as unknown as FakeServer,
    options,
    bodies: [],
    leakPerimeter: false,
    orderBySecondOnly: false,
    failNext: new Map(),
    asOf: new Date('2026-11-05T09:00:00.000Z'),
    unreadable: new Set(),
  }

  const apiNode = (n: IndexedNode, structure: 'area' | 'iteration', parent: string): unknown => {
    const kind = structure === 'area' ? 'Area' : 'Iteration'
    const below = n.workItemPath.split('\\').slice(1)
    const path = `\\${[options.projectName, kind, ...below].join('\\')}`
    return {
      id: n.id,
      identifier: `00000000-0000-4000-8000-${String(n.id).padStart(12, '0')}`,
      name: n.name,
      structureType: structure,
      hasChildren: n.children.length > 0,
      path,
      url: `${parent}/${kind}s/${below.join('/')}`,
      ...(n.children.length > 0
        ? { children: n.children.map((c) => apiNode(c, structure, parent)) }
        : {}),
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = decodeURIComponent(url.pathname)
    if (url.searchParams.get('api-version') !== '7.1') {
      json(res, 400, { message: 'api-version missing' })
      return
    }
    const auth = req.headers.authorization
    if (auth === undefined) {
      res.writeHead(203, { 'content-type': 'text/html' }).end('<html>Sign in</html>')
      return
    }
    if (auth !== expected) {
      json(res, 401, { message: 'unauthorized' })
      return
    }
    const failing = fake.failNext.get(path)
    if (failing !== undefined) {
      fake.failNext.delete(path)
      json(res, failing, { message: 'failure' }, failing === 429 ? { 'retry-after': '1' } : {})
      return
    }
    const base = `${fake.server.origin}/${org}`

    if (req.method === 'GET' && path === `/${org}/_apis/projects`) {
      const size = options.projectPageSize ?? 100
      const start = Number(url.searchParams.get('continuationToken') ?? '0')
      const page = projects.slice(start, start + size)
      const more = start + size < projects.length
      json(
        res,
        200,
        {
          count: page.length,
          value: page.map((p) => ({
            id: p.id,
            name: p.name,
            url: `${base}/_apis/projects/${p.id}`,
            state: p.state ?? 'wellFormed',
            revision: 1,
            visibility: 'private',
            lastUpdateTime: '2026-10-01T08:00:00.000Z',
          })),
        },
        more ? { 'x-ms-continuationtoken': String(start + size) } : {},
      )
      return
    }
    const one = projects.find((p) => path === `/${org}/_apis/projects/${p.id}`)
    if (req.method === 'GET' && one) {
      json(res, 200, { id: one.id, name: one.name, state: 'wellFormed' })
      return
    }
    if (req.method === 'GET' && path === `/${org}/${project}/_apis/wit/classificationnodes`) {
      const parent = `${base}/${project}/_apis/wit/classificationNodes`
      json(res, 200, {
        count: 2,
        value: [apiNode(areas.tree, 'area', parent), apiNode(iterations.tree, 'iteration', parent)],
      })
      return
    }
    if (req.method === 'POST' && path === `/${org}/${project}/_apis/wit/wiql`) {
      const body = JSON.parse(await bodyOf(req)) as { query: string }
      fake.bodies.push({ path, body })
      if (url.searchParams.get('timePrecision') !== 'true') {
        json(res, 400, { message: 'dates to the day only' })
        return
      }
      const top = Number(url.searchParams.get('$top') ?? '20000')
      const areaPaths = literals(body.query, 'System.AreaPath')
      const iterationPaths = literals(body.query, 'System.IterationPath')
      const since = /\[System\.ChangedDate\] >= '([^']+)'/.exec(body.query)?.[1]
      const matches = options.items
        .filter((i) => {
          if (fake.leakPerimeter) return true
          const area = String(i.fields['System.AreaPath'])
          const iteration = String(i.fields['System.IterationPath'])
          return (
            (areaPaths.length === 0 || areaPaths.some((a) => underPath(area, a))) &&
            (iterationPaths.length === 0 || iterationPaths.some((it) => underPath(iteration, it)))
          )
        })
        .filter(
          (i) =>
            since === undefined ||
            Date.parse(String(i.fields['System.ChangedDate'])) >= Date.parse(since),
        )
        .sort((a, b) => {
          const at = (i: FakeWorkItem) => {
            const ms = Date.parse(String(i.fields['System.ChangedDate']))
            return fake.orderBySecondOnly ? Math.floor(ms / 1000) : ms
          }
          const d = at(a) - at(b)
          return d !== 0 ? d : a.id - b.id
        })
      if (matches.length > 20_000 && top > 20_000) {
        json(res, 400, { message: 'VS402337: more than 20000 work items' })
        return
      }
      json(res, 200, {
        queryType: 'flat',
        queryResultType: 'workItem',
        asOf: fake.asOf.toISOString(),
        columns: [
          { referenceName: 'System.Id', name: 'ID', url: `${base}/_apis/wit/fields/System.Id` },
        ],
        sortColumns: [
          {
            field: { referenceName: 'System.ChangedDate', name: 'Changed Date' },
            descending: false,
          },
          { field: { referenceName: 'System.Id', name: 'ID' }, descending: false },
        ],
        workItems: matches.slice(0, top).map((i) => ({
          id: i.id,
          url: `${base}/_apis/wit/workItems/${i.id}`,
        })),
      })
      return
    }
    if (req.method === 'POST' && path === `/${org}/${project}/_apis/wit/workitemsbatch`) {
      const body = JSON.parse(await bodyOf(req)) as {
        ids: number[]
        fields: string[]
        asOf?: string
        errorPolicy?: string
      }
      fake.bodies.push({ path, body })
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) {
        json(res, 400, { message: 'VS403474: 1 to 200 ids' })
        return
      }
      const value = body.ids.map((id) => {
        const item = options.items.find((i) => i.id === id)
        if (!item || fake.unreadable.has(id)) return null
        const fields: Record<string, unknown> = {}
        for (const f of body.fields) {
          if (item.fields[f] !== undefined && item.fields[f] !== null) fields[f] = item.fields[f]
        }
        return { id: item.id, rev: item.rev, fields, url: `${base}/_apis/wit/workItems/${id}` }
      })
      json(res, 200, { count: value.length, value })
      return
    }
    json(res, 404, { message: 'not found' })
  }

  fake.server = await startFakeServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { message: 'fake failure' }))
  })
  return fake
}

/** A work item with the fields of the connector, as Azure DevOps returns them. */
export function workItem(
  id: number,
  fields: { area: string; iteration: string; changedAt: string } & Partial<{
    rev: number
    type: string
    title: string
    state: string
    assignedTo: { displayName: string; uniqueName: string } | null
    tags: string
    storyPoints: number
    priority: number
    createdAt: string
    closedAt: string
    parent: number
    description: string
  }>,
): FakeWorkItem {
  return {
    id,
    rev: fields.rev ?? 1,
    fields: {
      'System.Id': id,
      'System.WorkItemType': fields.type ?? 'User Story',
      'System.Title': fields.title ?? `Storia ${id}`,
      'System.State': fields.state ?? 'Active',
      'System.AssignedTo':
        fields.assignedTo === null
          ? undefined
          : {
              displayName: fields.assignedTo?.displayName ?? 'Mario Rossi',
              url: 'https://spsprodweu5.vssps.visualstudio.com/_apis/Identities/1',
              id: '11111111-1111-4111-8111-111111111111',
              uniqueName: fields.assignedTo?.uniqueName ?? 'mario.rossi@example.test',
              imageUrl: 'https://dev.azure.com/x/_apis/GraphProfile/MemberAvatars/aad.1',
              descriptor: 'aad.1',
            },
      'System.AreaPath': fields.area,
      'System.IterationPath': fields.iteration,
      'System.Tags': fields.tags,
      'Microsoft.VSTS.Scheduling.StoryPoints': fields.storyPoints,
      'Microsoft.VSTS.Common.Priority': fields.priority ?? 2,
      'System.CreatedDate': fields.createdAt,
      'System.ChangedDate': fields.changedAt,
      'Microsoft.VSTS.Common.ClosedDate': fields.closedAt,
      'System.Parent': fields.parent,
      'System.Description': fields.description,
    },
  }
}
