import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  acceptFinding,
  approveRun,
  type DeliverableFile,
  downloadFile,
  getRun,
  listRecipes,
  listRuns,
  MAX_CHANGE_REQUEST_LENGTH,
  type RunRecord,
  type RunView,
  requestChange,
  startRun,
} from '@octobrief/application'
import {
  DELIVERABLE_CONTENT_TYPES,
  type ParameterValues,
  RUN_PHASES,
  RUN_STATUSES,
} from '@octobrief/domain/recipe'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { requireSession } from '../middleware/session.ts'
import { ErrorSchema } from './schemas.ts'

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const errorResponse = (description: string) => ({ description, content: json(ErrorSchema) })
const notVisible = errorResponse('Project, run or file not found or not visible')
const notDecidable = errorResponse('The run is not waiting for a decision, or anomalies are open')
const forbidden = errorResponse('Only who asked for the document, owners and admins')

/** A JSON object whose shape is defined by the recipe format of the domain. */
const Structured = z.record(z.string(), z.unknown())

const RecipeSchema = z
  .object({
    slug: z.string(),
    version: z.string(),
    title: z.string(),
    purpose: z.string(),
    audience: z.string(),
    formats: z.array(z.string()),
    // The parameters of the run form, as the recipe declares them.
    parameters: z.array(Structured),
  })
  .openapi('Recipe')

const RunSchema = z
  .object({
    id: z.string(),
    recipeSlug: z.string(),
    recipeTitle: z.string(),
    status: z.enum(RUN_STATUSES),
    phase: z.enum(RUN_PHASES).nullable(),
    errorCode: z.string().nullable(),
    revisionError: z.string().nullable(),
    approval: z.enum(['approving', 'approved', 'render_failed']).nullable(),
    approvalError: z.string().nullable(),
    requestedBy: z.string(),
    createdAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().nullable(),
  })
  .openapi('Run')

const FileSchema = z.object({
  id: z.string(),
  audience: z.enum(['internal', 'client']),
  format: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
})

const RunViewSchema = z
  .object({
    run: RunSchema,
    // The internal document of the last revision (`DeliverableDocument` of the domain).
    document: Structured.nullable(),
    revision: z.number(),
    findings: z.array(
      z.object({
        code: z.string(),
        class: z.string(),
        kind: z.enum(['anomaly', 'warning']),
        refKey: z.string(),
        slot: z.string().nullable(),
        status: z.enum(['open', 'accepted', 'decided']).nullable(),
        acceptable: z.boolean(),
        text: z.string(),
        place: z.object({ section: z.string().optional(), block: z.string().optional() }),
        excerpt: z.string().nullable(),
      }),
    ),
    summary: Structured.nullable(),
    files: z.array(FileSchema),
    approvable: z.boolean(),
  })
  .openapi('RunView')

function toRunDto(run: RunRecord, recipeTitle: string) {
  return {
    id: run.id,
    recipeSlug: run.recipeSlug,
    recipeTitle,
    status: run.status,
    phase: run.phase,
    errorCode: run.errorCode,
    revisionError: run.revisionError,
    approval: run.approval,
    approvalError: run.approvalError,
    requestedBy: run.requestedBy,
    createdAt: run.createdAt.toISOString(),
    approvedAt: run.approvedAt?.toISOString() ?? null,
  }
}

const toFileDto = (file: DeliverableFile) => ({
  id: file.id,
  audience: file.audience,
  format: file.format,
  fileName: file.fileName,
  sizeBytes: file.sizeBytes,
})

function toViewDto(view: RunView) {
  return {
    run: toRunDto(view.run, view.recipeTitle),
    document: view.document as Record<string, unknown> | null,
    revision: view.revision,
    findings: view.findings.map((finding) => ({
      code: finding.code,
      class: finding.class,
      kind: finding.kind,
      refKey: finding.refKey,
      slot: finding.slot,
      status: finding.status,
      acceptable: finding.acceptable,
      text: finding.text,
      place: { ...finding.place },
      excerpt: finding.excerpt,
    })),
    summary: view.summary ? { ...view.summary } : null,
    files: view.files.map(toFileDto),
    approvable: view.approvable,
  }
}

const SlugParams = z.object({ slug: z.string().min(1).max(80) })
const RunParams = SlugParams.extend({ id: z.uuid() })

const recipesRoute = createRoute({
  method: 'get',
  path: '/recipes',
  tags: ['deliverables'],
  summary: 'The recipes of the installation: what documents can be made',
  responses: {
    200: {
      description: 'Recipes',
      content: json(z.object({ recipes: z.array(RecipeSchema) }).openapi('Recipes')),
    },
  },
})

const listRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/runs',
  tags: ['deliverables'],
  summary: 'The documents made or being made on a project, newest first',
  request: { params: SlugParams },
  responses: {
    200: { description: 'Runs', content: json(z.object({ runs: z.array(RunSchema) })) },
    404: notVisible,
  },
})

const startRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/runs',
  tags: ['deliverables'],
  summary: 'Start a run of a recipe; the document is written in the background',
  request: {
    params: SlugParams,
    body: {
      content: json(z.object({ recipeSlug: z.string().min(1).max(100), parameters: Structured })),
    },
  },
  responses: {
    201: { description: 'Run queued', content: json(RunSchema) },
    404: notVisible,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/runs/{id}',
  tags: ['deliverables'],
  summary: 'A run with its document, the findings of its checks and its files',
  request: { params: RunParams },
  responses: { 200: { description: 'Run', content: json(RunViewSchema) }, 404: notVisible },
})

const acceptRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/runs/{id}/acceptances',
  tags: ['deliverables'],
  summary: 'Accept an anomaly that may be accepted, with a reason kept with the document',
  request: {
    params: RunParams,
    body: {
      content: json(
        z.object({
          code: z.string().min(1).max(100),
          refKey: z.string().min(1).max(500),
          reason: z.string().max(2000),
        }),
      ),
    },
  },
  responses: {
    200: { description: 'Run after the acceptance', content: json(RunViewSchema) },
    400: errorResponse('The anomaly cannot be accepted, or the reason is too short'),
    403: forbidden,
    404: notVisible,
    409: notDecidable,
  },
})

const changeRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/runs/{id}/changes',
  tags: ['deliverables'],
  summary: 'Ask for some texts of the document to be written again',
  request: {
    params: RunParams,
    body: {
      content: json(
        z.object({
          slots: z.array(z.string().min(1).max(200)).min(1).max(50),
          request: z.string().max(MAX_CHANGE_REQUEST_LENGTH),
        }),
      ),
    },
  },
  responses: {
    202: { description: 'Revision queued' },
    400: errorResponse('No text named, or nothing asked'),
    403: forbidden,
    404: notVisible,
    409: notDecidable,
  },
})

const approveRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/runs/{id}/approval',
  tags: ['deliverables'],
  summary: 'Approve the document; its files are made in the background',
  request: { params: RunParams },
  responses: {
    202: { description: 'Approval recorded, files being made' },
    403: forbidden,
    404: notVisible,
    409: notDecidable,
  },
})

const fileRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/runs/{id}/files/{fileId}',
  tags: ['deliverables'],
  summary: 'Download a file of an approved document',
  request: { params: RunParams.extend({ fileId: z.uuid() }) },
  responses: {
    200: {
      description: 'The file',
      content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    404: notVisible,
  },
})

export function registerDeliverableRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  // The catalog is for signed-in people only, like everything under a project.
  app.use('/recipes', requireSession(deps))
  app.openapi(recipesRoute, (c) =>
    c.json(
      {
        recipes: listRecipes(deps).map(({ recipe }) => ({
          slug: recipe.slug,
          version: recipe.version,
          title: recipe.title,
          purpose: recipe.purpose,
          audience: recipe.audience,
          formats: [...recipe.render.formats],
          parameters: recipe.parameters as Array<Record<string, unknown>>,
        })),
      },
      200,
    ),
  )

  app.openapi(listRoute, async (c) => {
    const runs = await listRuns(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json({ runs: runs.map((run) => toRunDto(run, run.recipeTitle)) }, 200)
  })

  app.openapi(startRoute, async (c) => {
    const body = c.req.valid('json')
    const run = await startRun(deps, c.get('session').user, c.req.valid('param').slug, {
      recipeSlug: body.recipeSlug,
      // Checked against the recipe by the gathering: a wrong value fails the run with a code.
      parameters: body.parameters as ParameterValues,
    })
    const title = deps.library.get(run.recipeSlug)?.recipe.title ?? run.recipeSlug
    return c.json(toRunDto(run, title), 201)
  })

  app.openapi(getRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    return c.json(toViewDto(await getRun(deps, c.get('session').user, slug, id)), 200)
  })

  app.openapi(acceptRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    const view = await acceptFinding(deps, c.get('session').user, slug, id, c.req.valid('json'))
    return c.json(toViewDto(view), 200)
  })

  app.openapi(changeRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await requestChange(deps, c.get('session').user, slug, id, c.req.valid('json'))
    return c.body(null, 202)
  })

  app.openapi(approveRoute, async (c) => {
    const { slug, id } = c.req.valid('param')
    await approveRun(deps, c.get('session').user, slug, id)
    return c.body(null, 202)
  })

  app.openapi(fileRoute, async (c) => {
    const { slug, id, fileId } = c.req.valid('param')
    const { file, bytes } = await downloadFile(deps, c.get('session').user, slug, id, fileId)
    return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
      'content-type': DELIVERABLE_CONTENT_TYPES[file.format],
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    })
  })
}
