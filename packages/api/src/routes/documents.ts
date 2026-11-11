import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  deleteDocument,
  getDocumentText,
  listDocuments,
  reclassifyDocument,
  uploadDocument,
} from '@octobrief/application'
import {
  AUDIENCES,
  DATE_SOURCES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  type DocumentSummary,
  MAX_DOCUMENT_BYTES,
  UNCERTAIN_FIELDS,
} from '@octobrief/domain'
import { bodyLimit } from 'hono/body-limit'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { ErrorSchema } from './schemas.ts'

/** Room for the multipart envelope around the largest accepted file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024

const DocumentSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    mediaType: z.string(),
    sizeBytes: z.number(),
    status: z.enum(DOCUMENT_STATUSES),
    kind: z.enum(DOCUMENT_KINDS).nullable(),
    audience: z.enum(AUDIENCES).nullable(),
    audienceSource: z.enum(['pm', 'rule', 'default']).nullable(),
    documentDate: z.iso.datetime().nullable(),
    dateSource: z.enum(DATE_SOURCES).nullable(),
    uncertain: z.array(z.enum(UNCERTAIN_FIELDS)),
    warnings: z.array(z.string()),
    chunkCount: z.number(),
    uploadedBy: z.string(),
    uploaderName: z.string(),
    uploadedAt: z.iso.datetime(),
  })
  .openapi('Document')

const LocatorSchema = z
  .union([
    z.object({ kind: z.literal('page'), page: z.number() }),
    z.object({ kind: z.literal('paragraph'), index: z.number() }),
    z.object({ kind: z.literal('slide'), slide: z.number() }),
    z.object({ kind: z.literal('cell'), sheet: z.string(), ref: z.string() }),
    z.object({ kind: z.literal('line'), from: z.number(), to: z.number() }),
  ])
  .openapi('Locator')

const DocumentTextSchema = z
  .object({
    document: DocumentSchema,
    chunks: z.array(z.object({ locator: LocatorSchema, text: z.string() })),
  })
  .openapi('DocumentText')

const SlugParams = z.object({ slug: z.string().min(1).max(80) })
const DocumentParams = SlugParams.extend({ id: z.uuid() })
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const errorResponse = (description: string) => ({ description, content: json(ErrorSchema) })

function toDto(document: DocumentSummary) {
  return {
    id: document.id,
    fileName: document.fileName,
    mediaType: document.mediaType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    kind: document.kind,
    audience: document.audience,
    audienceSource: document.audienceSource,
    documentDate: document.documentDate?.toISOString() ?? null,
    dateSource: document.dateSource,
    uncertain: [...document.uncertain],
    warnings: [...document.warnings],
    chunkCount: document.chunkCount,
    uploadedBy: document.uploadedBy,
    uploaderName: document.uploaderName,
    uploadedAt: document.uploadedAt.toISOString(),
  }
}

const listRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/documents',
  tags: ['documents'],
  summary: 'Documents of a project, newest first',
  request: { params: SlugParams },
  responses: {
    200: {
      description: 'Documents',
      content: json(z.object({ documents: z.array(DocumentSchema) }).openapi('Documents')),
    },
    404: errorResponse('Project not found or not visible'),
  },
})

const uploadRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/documents',
  tags: ['documents'],
  summary: 'Upload a file; extraction and classification follow in the background',
  request: {
    params: SlugParams,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.instanceof(File).openapi({ type: 'string', format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Document stored, processing queued', content: json(DocumentSchema) },
    400: errorResponse('Empty file or unusable name'),
    404: errorResponse('Project not found or not visible'),
    409: errorResponse('The project already holds this file'),
    413: errorResponse('File too large'),
  },
})

const textRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/documents/{id}',
  tags: ['documents'],
  summary: 'One document with the start of its extracted text',
  request: { params: DocumentParams },
  responses: {
    200: { description: 'Document and text', content: json(DocumentTextSchema) },
    404: errorResponse('Not found or not visible'),
  },
})

const reclassifyRoute = createRoute({
  method: 'patch',
  path: '/projects/{slug}/documents/{id}',
  tags: ['documents'],
  summary: 'Record the kind or audience the PM chose',
  request: {
    params: DocumentParams,
    body: {
      content: json(
        z.object({
          kind: z.enum(DOCUMENT_KINDS).optional(),
          audience: z.enum(AUDIENCES).optional(),
        }),
      ),
    },
  },
  responses: {
    200: { description: 'Updated document', content: json(DocumentSchema) },
    404: errorResponse('Not found or not visible'),
    409: errorResponse('Not classified yet'),
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/projects/{slug}/documents/{id}',
  tags: ['documents'],
  summary: 'Remove a document, its text and its bytes',
  request: { params: DocumentParams },
  responses: {
    204: { description: 'Removed' },
    403: errorResponse('Only the uploader, owners and admins'),
    404: errorResponse('Not found or not visible'),
  },
})

/** Registered after the project routes, whose session guard covers `/projects/*`. */
export function registerDocumentRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.post(
    '/projects/:slug/documents',
    bodyLimit({
      maxSize: MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: 'too_large' }, 413),
    }),
  )

  app.openapi(listRoute, async (c) => {
    const documents = await listDocuments(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json({ documents: documents.map(toDto) }, 200)
  })

  app.openapi(uploadRoute, async (c) => {
    const { file } = c.req.valid('form')
    const document = await uploadDocument(deps, c.get('session').user, c.req.valid('param').slug, {
      fileName: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })
    return c.json(toDto(document), 201)
  })

  app.openapi(textRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    const { document, chunks } = await getDocumentText(deps, c.get('session').user, slug, id)
    return c.json({ document: toDto(document), chunks }, 200)
  })

  app.openapi(reclassifyRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    const document = await reclassifyDocument(
      deps,
      c.get('session').user,
      slug,
      id,
      c.req.valid('json'),
    )
    return c.json(toDto(document), 200)
  })

  app.openapi(deleteRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await deleteDocument(deps, c.get('session').user, slug, id)
    return c.body(null, 204)
  })
}
