import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  ApplicationError,
  createSource,
  deleteSource,
  ingestDelivery,
  listSources,
  requestSync,
  rotateIngestToken,
} from '@octobrief/application'
import {
  type Delivery,
  DOCUMENT_KINDS,
  type ItemPerson,
  MAX_ITEMS_PER_DELIVERY,
  SOURCE_KINDS,
  type Source,
} from '@octobrief/domain'
import { bodyLimit } from 'hono/body-limit'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { ErrorSchema } from './schemas.ts'

/** The largest delivery a feeder sends in one call. */
export const MAX_DELIVERY_BYTES = 32 * 1024 * 1024
const BEARER = /^Bearer (\S+)$/

const SourceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(SOURCE_KINDS),
    name: z.string(),
    perimeter: z.array(z.string()),
    lastSyncAt: z.iso.datetime().nullable(),
    dataAsOf: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
    documentCount: z.number(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Source')

function toDto(source: Source) {
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    perimeter: [...source.perimeter],
    lastSyncAt: source.lastSyncAt?.toISOString() ?? null,
    dataAsOf: source.dataAsOf?.toISOString() ?? null,
    lastError: source.lastError,
    documentCount: source.documentCount,
    createdAt: source.createdAt.toISOString(),
  }
}

const SlugParams = z.object({ slug: z.string().min(1).max(80) })
const SourceParams = SlugParams.extend({ id: z.uuid() })
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const errorResponse = (description: string) => ({ description, content: json(ErrorSchema) })
const notVisible = errorResponse('Project or source not found or not visible')
const ownersOnly = errorResponse('Only the owner of the project or an admin')

const listRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/sources',
  tags: ['sources'],
  summary: 'Sources of a project with the freshness of their data',
  request: { params: SlugParams },
  responses: {
    200: {
      description: 'Sources',
      content: json(z.object({ sources: z.array(SourceSchema) }).openapi('Sources')),
    },
    404: notVisible,
  },
})

const createSourceRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/sources',
  tags: ['sources'],
  summary: 'Connect a source; a pushing one returns the token of its feeder, once',
  request: {
    params: SlugParams,
    body: {
      content: json(
        z
          .object({
            kind: z.string().max(20),
            name: z.string().max(200),
            config: z.record(z.string(), z.unknown()).optional(),
            secret: z.string().max(8192).optional(),
            scope: z.array(z.string().max(200)).max(50).optional(),
          })
          .openapi('NewSource'),
      ),
    },
  },
  responses: {
    201: {
      description: 'Source connected',
      content: json(
        z
          .object({ source: SourceSchema, ingestToken: z.string().nullable() })
          .openapi('ConnectedSource'),
      ),
    },
    400: errorResponse('Invalid name, kind, settings or credential'),
    403: ownersOnly,
    404: notVisible,
    409: errorResponse('The project already has a source of this name'),
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/sources/{id}',
  tags: ['sources'],
  summary: 'Disconnect a source; its documents stay',
  request: { params: SourceParams },
  responses: { 204: { description: 'Disconnected' }, 403: ownersOnly, 404: notVisible },
})

const tokenRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/sources/{id}/token',
  tags: ['sources'],
  summary: 'A new token for the feeder; the old one stops working',
  request: { params: SourceParams },
  responses: {
    200: {
      description: 'The new token, shown once',
      content: json(z.object({ ingestToken: z.string() })),
    },
    403: ownersOnly,
    404: notVisible,
    409: errorResponse('The source is read by the worker'),
  },
})

const syncRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/sources/{id}/sync',
  tags: ['sources'],
  summary: 'Read a Jira or Azure DevOps source now',
  request: { params: SourceParams },
  responses: {
    202: { description: 'Reading queued' },
    403: ownersOnly,
    404: notVisible,
    409: errorResponse('The source is fed by its feeder'),
  },
})

const instant = z.iso.datetime({ offset: true })
const PersonSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().max(320).optional(),
  untrusted: z.boolean().optional(),
})
const itemFields = {
  externalId: z.string().min(1).max(500),
  version: z.string().min(1).max(200),
  title: z.string().max(500),
  originAt: instant.nullable().optional(),
  url: z.url().max(2000).nullable().optional(),
  people: z.array(PersonSchema).max(500).optional(),
}
const DeliverySchema = z
  .object({
    dataAsOf: instant.nullable().optional(),
    documents: z
      .array(
        z
          .object({
            ...itemFields,
            mediaType: z.string().min(1).max(255),
            /** The content as text, or as base64 for a binary file: exactly one of the two. */
            text: z.string().optional(),
            contentBase64: z.base64().optional(),
            kind: z.enum(DOCUMENT_KINDS).optional(),
            fileModifiedAt: instant.optional(),
          })
          .refine((d) => (d.text === undefined) !== (d.contentBase64 === undefined), {
            message: 'exactly one of text and contentBase64',
          }),
      )
      .max(MAX_ITEMS_PER_DELIVERY)
      .optional(),
    records: z
      .array(z.object({ ...itemFields, record: z.record(z.string(), z.unknown()) }))
      .max(MAX_ITEMS_PER_DELIVERY)
      .optional(),
    rows: z
      .array(
        z.object({
          view: z.string().min(1).max(200),
          perimeter: z.string().min(1).max(200),
          rows: z.array(
            z.object({
              key: z.string().min(1).max(500),
              values: z.record(z.string(), z.unknown()),
            }),
          ),
          extractedAt: instant,
          sourceSyncedAt: instant.nullable().optional(),
        }),
      )
      .max(50)
      .optional(),
    removed: z.array(z.string().min(1).max(500)).max(1000).optional(),
  })
  .openapi('Delivery')

const OutcomeSchema = z
  .object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    duplicates: z.number(),
    records: z.number(),
    rows: z.number(),
    removed: z.number(),
  })
  .openapi('DeliveryOutcome')

const ingestRoute = createRoute({
  method: 'post',
  path: '/ingest/{id}',
  tags: ['sources'],
  summary: 'A delivery of a feeder, authenticated by the token of the source (Bearer)',
  request: { params: z.object({ id: z.uuid() }), body: { content: json(DeliverySchema) } },
  responses: {
    200: { description: 'What was stored', content: json(OutcomeSchema) },
    400: errorResponse('Malformed or over the limits'),
    401: errorResponse('Unknown source or wrong token'),
    413: errorResponse('Delivery too large'),
  },
})

const dateOf = (value: string | null | undefined): Date | null => (value ? new Date(value) : null)
const peopleOf = (people: z.infer<typeof PersonSchema>[] | undefined): ItemPerson[] =>
  (people ?? []).map((p) => ({
    displayName: p.displayName,
    ...(p.email ? { email: p.email } : {}),
    ...(p.untrusted ? { untrusted: true } : {}),
  }))

function toDelivery(body: z.infer<typeof DeliverySchema>): Delivery {
  const common = (item: {
    externalId: string
    version: string
    title: string
    originAt?: string | null | undefined
    url?: string | null | undefined
    people?: z.infer<typeof PersonSchema>[] | undefined
  }) => ({
    externalId: item.externalId,
    version: item.version,
    title: item.title,
    originAt: dateOf(item.originAt),
    url: item.url ?? null,
    people: peopleOf(item.people),
  })
  return {
    dataAsOf: dateOf(body.dataAsOf),
    documents: (body.documents ?? []).map((d) => ({
      ...common(d),
      mediaType: d.mediaType,
      bytes:
        d.text !== undefined
          ? new TextEncoder().encode(d.text)
          : new Uint8Array(Buffer.from(d.contentBase64 as string, 'base64')),
      ...(d.kind ? { systemKind: d.kind } : {}),
      ...(d.fileModifiedAt ? { fileModifiedAt: new Date(d.fileModifiedAt) } : {}),
    })),
    records: (body.records ?? []).map((r) => ({ ...common(r), record: r.record })),
    rows: (body.rows ?? []).map((view) => ({
      view: view.view,
      perimeter: view.perimeter,
      rows: view.rows,
      extractedAt: new Date(view.extractedAt),
      sourceSyncedAt: dateOf(view.sourceSyncedAt),
    })),
    removed: body.removed ?? [],
  }
}

export function registerSourceRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.openapi(listRoute, async (c) => {
    const sources = await listSources(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json({ sources: sources.map(toDto) }, 200)
  })

  app.openapi(createSourceRoute, async (c) => {
    const { source, ingestToken } = await createSource(
      deps,
      c.get('session').user,
      c.req.valid('param').slug,
      c.req.valid('json'),
    )
    return c.json({ source: toDto(source), ingestToken }, 201)
  })

  app.openapi(deleteRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await deleteSource(deps, c.get('session').user, slug, id)
    return c.body(null, 204)
  })

  app.openapi(tokenRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    const ingestToken = await rotateIngestToken(deps, c.get('session').user, slug, id)
    return c.json({ ingestToken }, 200)
  })

  app.openapi(syncRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await requestSync(deps, c.get('session').user, slug, id)
    return c.body(null, 202)
  })

  // No session here: the feeder runs on the PM's computer and presents the token of its source.
  app.use(
    '/ingest/*',
    bodyLimit({
      maxSize: MAX_DELIVERY_BYTES,
      onError: (c) => c.json({ error: 'too_large' }, 413),
    }),
  )
  app.openapi(ingestRoute, async (c) => {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) throw new ApplicationError('unauthenticated', 'no bearer token')
    const outcome = await ingestDelivery(
      { sources: deps.sources, items: deps.items, blobs: deps.blobs, jobs: deps.queue },
      c.req.valid('param').id,
      token,
      toDelivery(c.req.valid('json')),
    )
    return c.json(outcome, 200)
  })
}
