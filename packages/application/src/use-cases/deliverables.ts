import { createHash } from 'node:crypto'
import { isAdmin, type ProjectId, type User, type UserId } from '@octobrief/domain'
import {
  type Acceptance,
  type AnswerStore,
  acceptAnomaly,
  anomaliesOfRows,
  binaryFormatOf,
  type CitedSources,
  DEFAULT_RUN_CAPS,
  type DeclaredValue,
  type DeliverableDocument,
  DomainError,
  deliverableFileName,
  EMPTY_USAGE,
  type FileAudience,
  fileDocument,
  fileLayout,
  type InternalDocument,
  type KnowledgeReader,
  type Lang,
  NEUTRAL_TEMPLATE_SLUGS,
  type ParameterValues,
  projectClientVersion,
  type RecipeDataReader,
  type RedTeamRow,
  type RenderFormat,
  type RunUsage,
  redTeamFindingText,
  renderEnvelope,
  renderFailureOf,
  renderMarkdown,
  runCapsForRecipe,
  runFileAudiences,
  runRedTeamContext,
  type StoredAnomaly,
  type SuspiciousHit,
  summarizeRedTeam,
  type TrackerReader,
} from '@octobrief/domain/recipe'
import { ApplicationError } from '../errors.ts'
import type { BlobStore } from '../ports/blob-store.ts'
import {
  type DeliverableFile,
  type LibraryRecipe,
  type NewDeliverableFile,
  type RecipeLibrary,
  type Renderer,
  RendererUnavailable,
  type RunDetails,
  type RunRecord,
  type RunRepository,
  type RunWorkStore,
  type TemplateStore,
} from '../ports/deliverable-stores.ts'
import type { JobQueue } from '../ports/job-queue.ts'
import type { Logger } from '../ports/logger.ts'
import { ModelError, type ModelRunner, modelErrorCode } from '../ports/model-runner.ts'
import {
  budgetedRunner,
  draftRecipeRun,
  type RecipeRunDeps,
  RunError,
  reviseRecipeRun,
  storedDraft,
} from '../recipe/run.ts'
import { getProject, type ProjectDependencies } from './projects.ts'

/** The longest request of change the PM may write. */
export const MAX_CHANGE_REQUEST_LENGTH = 2000
/** The largest file an approval stores. */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Stored when a run or a render fails for a reason that has no code of its own. */
const UNEXPECTED_RUN_FAILURE = 'run_unexpected'
const UNEXPECTED_RENDER_FAILURE = 'render_error'

export interface DeliverableDependencies extends ProjectDependencies {
  readonly library: RecipeLibrary
  readonly runs: RunRepository
  readonly blobs: BlobStore
  readonly queue: JobQueue
  readonly now?: () => Date
}

/** A finding of the red team as the PM reads it. */
export interface FindingView {
  readonly code: string
  readonly class: string
  readonly kind: 'anomaly' | 'warning'
  readonly refKey: string
  readonly contentHash: string
  /** The text slot the finding is about, when it is about one: where a change can be asked. */
  readonly slot: string | null
  readonly status: StoredAnomaly['status'] | null
  readonly acceptable: boolean
  readonly text: string
  /** Where in the document: the titles of the section and of the block, when known. */
  readonly place: { readonly section?: string; readonly block?: string }
  /** The words the finding is about, when it is about some. */
  readonly excerpt: string | null
}

export interface RunView {
  readonly run: RunRecord
  readonly recipeTitle: string
  /** The document of the last revision; null until it is written. */
  readonly document: InternalDocument | null
  readonly revision: number
  readonly findings: readonly FindingView[]
  readonly summary: ReturnType<typeof summarizeRedTeam> | null
  readonly files: readonly DeliverableFile[]
  /** Whether nothing stands in the way of an approval. */
  readonly approvable: boolean
}

function findingsOf(details: RunDetails, lang: Lang): FindingView[] {
  const rows = details.revision?.rows ?? []
  const { acceptances, decisions } = details.run
  const status = new Map(
    anomaliesOfRows(rows, acceptances, decisions).map((a) => [`${a.code}|${a.refKey}`, a]),
  )
  const seen = new Set<string>()
  const findings: FindingView[] = []
  for (const row of rows) {
    if (row.outcome !== 'anomaly' && row.outcome !== 'warning') continue
    const key = `${row.code}|${row.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    const anomaly = row.outcome === 'anomaly' ? (status.get(key) ?? null) : null
    findings.push({
      code: row.code,
      class: row.class,
      kind: row.outcome,
      refKey: row.ref,
      contentHash: row.contentHash,
      slot: typeof row.detail.slot === 'string' ? row.detail.slot : null,
      status: anomaly?.status ?? null,
      acceptable: row.acceptable,
      text: findingText(row, lang),
      place: placeOf(row),
      excerpt: typeof row.detail.excerpt === 'string' ? row.detail.excerpt : null,
    })
  }
  return findings
}

function placeOf(row: RedTeamRow): { section?: string; block?: string } {
  const place = row.detail.place
  if (typeof place !== 'object' || place === null || Array.isArray(place)) return {}
  const { section, block } = place as { section?: unknown; block?: unknown }
  return {
    ...(typeof section === 'string' ? { section } : {}),
    ...(typeof block === 'string' ? { block } : {}),
  }
}

/** The words of a finding; its code when the words cannot be made (a row of an older version). */
function findingText(row: RedTeamRow, lang: Lang): string {
  try {
    return redTeamFindingText(
      {
        code: row.code,
        // A row keeps its reference as canonical JSON: the key acceptances are matched by.
        ref: JSON.parse(row.ref),
        place: placeOf(row),
        detail: row.detail,
      } as Parameters<typeof redTeamFindingText>[0],
      lang,
    )
  } catch {
    return row.code
  }
}

/** An approval asked and not failed: nothing more to decide. A failed render can be asked again. */
const approvalSettled = (run: RunRecord): boolean =>
  run.approval === 'approving' || run.approval === 'approved'

function viewOf(details: RunDetails, library: RecipeLibrary): RunView {
  const { run, revision, files } = details
  const recipe = library.get(run.recipeSlug)?.recipe
  const lang = (recipe?.lang ?? 'it') as Lang
  const findings = findingsOf(details, lang)
  const open = findings.some((finding) => finding.status === 'open')
  return {
    run,
    recipeTitle: recipe?.title ?? run.recipeSlug,
    document: revision ? storedDraft(revision.document) : null,
    revision: revision?.seq ?? 0,
    findings,
    summary: revision ? summarizeRedTeam(revision.rows, run.acceptances, run.decisions) : null,
    files,
    approvable: run.status === 'ready' && !approvalSettled(run) && revision !== null && !open,
  }
}

export function listRecipes(deps: Pick<DeliverableDependencies, 'library'>): LibraryRecipe[] {
  return [...deps.library.list()]
}

/** Starts a run of a recipe on a project; the document is written in the background. */
export async function startRun(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  input: { recipeSlug: string; parameters: ParameterValues },
): Promise<RunRecord> {
  const project = await getProject(deps, viewer, slug)
  const found = deps.library.get(input.recipeSlug)
  if (!found) throw new ApplicationError('not_found', 'recipe not found')
  const run = await deps.runs.create(viewer.id, {
    projectId: project.id,
    recipeSlug: found.recipe.slug,
    recipeVersion: found.recipe.version,
    recipeHash: found.hash,
    parameters: input.parameters,
  })
  await deps.queue.enqueue('deliverable.run', { runId: run.id })
  return run
}

export async function listRuns(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
): Promise<Array<RunRecord & { recipeTitle: string }>> {
  const project = await getProject(deps, viewer, slug)
  const runs = await deps.runs.list(viewer.id, project.id)
  return runs.map((run) => ({
    ...run,
    recipeTitle: deps.library.get(run.recipeSlug)?.recipe.title ?? run.recipeSlug,
  }))
}

async function runDetails(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
): Promise<{ details: RunDetails; canDecide: boolean }> {
  const project = await getProject(deps, viewer, slug)
  const details = await deps.runs.find(viewer.id, project.id, runId)
  if (!details) throw new ApplicationError('not_found', 'run not found')
  // Who asked for the document, the owner of the project and admins judge and approve it.
  const canDecide =
    details.run.requestedBy === viewer.id || project.memberRole === 'owner' || isAdmin(viewer)
  return { details, canDecide }
}

export async function getRun(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
): Promise<RunView> {
  const { details } = await runDetails(deps, viewer, slug, runId)
  return viewOf(details, deps.library)
}

async function decidableRun(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
): Promise<RunDetails> {
  const { details, canDecide } = await runDetails(deps, viewer, slug, runId)
  if (!canDecide) throw new ApplicationError('forbidden', 'only who asked, owners and admins')
  if (details.run.status !== 'ready' || approvalSettled(details.run)) {
    throw new ApplicationError('conflict', 'the run is not waiting for a decision')
  }
  return details
}

/** Accepts an anomaly the PM may accept, with a reason that is kept with the document. */
export async function acceptFinding(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
  input: { code: string; refKey: string; reason: string },
): Promise<RunView> {
  const details = await decidableRun(deps, viewer, slug, runId)
  const { run, revision } = details
  const anomaly = anomaliesOfRows(revision?.rows ?? [], run.acceptances, run.decisions).find(
    (a) => a.code === input.code && a.refKey === input.refKey && a.status === 'open',
  )
  if (!anomaly) throw new ApplicationError('not_found', 'no open anomaly with this reference')
  const result = acceptAnomaly(anomaly, {
    reason: input.reason,
    by: viewer.id,
    at: (deps.now?.() ?? new Date()).toISOString(),
  })
  if (!result.ok) {
    throw new ApplicationError('invalid', result.refusal, {
      cause: new DomainError(result.refusal),
    })
  }
  const acceptances: Acceptance[] = [...run.acceptances, result.acceptance]
  await deps.runs.saveJudgements(viewer.id, run.id, { acceptances, decisions: run.decisions })
  return viewOf({ ...details, run: { ...run, acceptances } }, deps.library)
}

/** Asks for some texts of the document to be written again, with what the PM wants changed. */
export async function requestChange(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
  input: { slots: readonly string[]; request: string },
): Promise<void> {
  const details = await decidableRun(deps, viewer, slug, runId)
  const request = input.request.trim()
  if (request === '' || request.length > MAX_CHANGE_REQUEST_LENGTH || input.slots.length === 0) {
    throw new ApplicationError('invalid', 'a change names its texts and says what to change')
  }
  await deps.queue.enqueue('deliverable.revise', {
    runId: details.run.id,
    slots: [...input.slots],
    request,
  })
}

/** Approves the document: refused while an anomaly is open; the files are made in background. */
export async function approveRun(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
): Promise<void> {
  const details = await decidableRun(deps, viewer, slug, runId)
  if (!viewOf(details, deps.library).approvable) {
    throw new ApplicationError('conflict', 'open anomalies stand in the way')
  }
  if (!(await deps.runs.requestApproval(viewer.id, details.run.id))) {
    throw new ApplicationError('conflict', 'the run is not waiting for a decision')
  }
  await deps.queue.enqueue('deliverable.render', { runId: details.run.id })
}

/** The bytes of a file of an approved run. */
export async function downloadFile(
  deps: DeliverableDependencies,
  viewer: User,
  slug: string,
  runId: string,
  fileId: string,
): Promise<{ file: DeliverableFile; bytes: Uint8Array }> {
  const { details } = await runDetails(deps, viewer, slug, runId)
  const file = details.files.find((candidate) => candidate.id === fileId)
  if (!file) throw new ApplicationError('not_found', 'file not found')
  return { file, bytes: await deps.blobs.get(file.blobKey) }
}

// The worker -------------------------------------------------------------------------------------

/** What a run reads a project with: every statement names the project. */
export interface RunReading<Tx> {
  readonly data: RecipeDataReader<Tx>
  readonly reader: KnowledgeReader<Tx>
  readonly store: AnswerStore<Tx>
  readonly tracker?: TrackerReader<Tx>
  citedSources(
    tx: Tx,
    projectId: ProjectId,
    ids: { evidenceIds: readonly string[]; factIds: readonly string[] },
  ): Promise<CitedSources>
  suspicious(
    tx: Tx,
    projectId: ProjectId,
    evidenceIds: readonly string[],
  ): Promise<Record<string, SuspiciousHit[]>>
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

export interface RunWorkDependencies<Tx> {
  readonly runs: RunWorkStore
  readonly library: RecipeLibrary
  readonly reading: RunReading<Tx>
  readonly templates: TemplateStore
  /** Already protected: guarded and pseudonymizing. */
  readonly runner: ModelRunner
  readonly logger: Logger
  readonly now?: () => Date
}

function engineDeps<Tx>(
  deps: RunWorkDependencies<Tx>,
  run: RunRecord,
  onPhase: RecipeRunDeps<Tx>['onPhase'],
): RecipeRunDeps<Tx> {
  return {
    projectId: run.projectId as ProjectId,
    userId: run.requestedBy as UserId,
    withTx: deps.reading.withTx,
    data: deps.reading.data,
    reader: deps.reading.reader,
    store: deps.reading.store,
    ...(deps.reading.tracker ? { tracker: deps.reading.tracker } : {}),
    citedSources: deps.reading.citedSources,
    suspicious: deps.reading.suspicious,
    // Values the PM declared in earlier documents are not kept yet: nothing to compare with.
    declaredValues: async (): Promise<DeclaredValue[]> => [],
    now: deps.now?.() ?? new Date(),
    ...(onPhase ? { onPhase } : {}),
  }
}

function failureCode(error: unknown): string {
  if (error instanceof RunError) return `run_${error.code}`
  if (error instanceof ModelError) return modelErrorCode(error)
  if (error instanceof DomainError) return error.code
  return UNEXPECTED_RUN_FAILURE
}

/** The template of the binary file of a recipe, as the snapshot of a run records it. */
async function templateOf(templates: TemplateStore, recipe: LibraryRecipe['recipe']) {
  const binary = binaryFormatOf(recipe.render)
  if (binary === null) return null
  const template = await templates.find(recipe.render.template ?? NEUTRAL_TEMPLATE_SLUGS[binary])
  return template !== null && template.format === binary ? template : null
}

/**
 * Worker job: gathers the data the recipe asks for, has the model write its texts, checks the
 * document and stores the first revision. A failure is recorded on the run with a stable code.
 */
export function createRunRecipeHandler<Tx>(deps: RunWorkDependencies<Tx>) {
  return async ({ runId }: { runId: string }): Promise<void> => {
    const details = await deps.runs.load(runId)
    if (details?.run.status !== 'queued') return
    const { run } = details
    const usage: RunUsage = { ...EMPTY_USAGE }
    const fail = async (code: string) => {
      await deps.runs.move(runId, ['queued', 'running'], {
        status: 'failed',
        phase: null,
        errorCode: code,
        usage,
      })
      deps.logger.error('recipe run failed', { runId, code })
    }
    const found = deps.library.get(run.recipeSlug)
    if (!found || found.hash !== run.recipeHash) return fail('run_recipe_unavailable')
    const caps = runCapsForRecipe(found.recipe, DEFAULT_RUN_CAPS)
    if (!caps.ok) return fail(`run_${caps.code}`)
    if (!(await deps.runs.move(runId, ['queued'], { status: 'running', phase: 'gathering' }))) {
      return
    }
    const runner = budgetedRunner(deps.runner, {
      caps: caps.caps,
      price: null,
      rate: null,
      usage,
      startedAt: Date.now(),
    })
    try {
      const template = await templateOf(deps.templates, found.recipe)
      const draft = await draftRecipeRun(
        runner,
        {
          recipe: found.recipe,
          recipeHash: found.hash,
          settingsHash: null,
          parameters: run.parameters,
          modelAlias: deps.runner.backend,
          render: {
            settings: { parameterDefaults: {}, templateRef: null, mapping: null, labels: {} },
            template:
              template === null
                ? null
                : {
                    slug: template.slug,
                    format: template.format,
                    contentHash: template.contentHash,
                  },
          },
        },
        {
          ...engineDeps(deps, run, async (phase) => {
            await deps.runs.move(runId, ['running'], { phase })
          }),
          onGathered: (snapshot, hash, gate) =>
            deps.runs.saveSnapshot(runId, { snapshot, hash }, gate),
        },
      )
      await deps.runs.saveRevision(runId, {
        origin: 'writer',
        document: draft.document,
        rows: draft.rows,
        verifications: draft.verifications,
        skeletonHash: draft.result.skeletonHash,
        dataHash: draft.result.dataHash,
      })
      await deps.runs.move(runId, ['running'], { status: 'ready', phase: null, usage })
      deps.logger.info('recipe run ready', {
        runId,
        recipe: run.recipeSlug,
        anomalies: draft.result.anomalies.length,
        warnings: draft.result.warnings.length,
        modelCalls: usage.modelCalls,
      })
    } catch (error) {
      await fail(failureCode(error))
    }
  }
}

/**
 * Worker job: writes again the texts the PM named, with the PM's request. The new revision is
 * kept only when it changes nothing else and adds no anomaly; otherwise the reason is recorded
 * and the document stays as it was.
 */
export function createReviseRunHandler<Tx>(deps: RunWorkDependencies<Tx>) {
  return async (job: { runId: string; slots: string[]; request: string }): Promise<void> => {
    const details = await deps.runs.load(job.runId)
    if (details?.run.status !== 'ready' || details.run.approval !== null) return
    const { run, revision } = details
    const found = deps.library.get(run.recipeSlug)
    if (!revision || !run.gate || !found || found.hash !== run.recipeHash) return
    if (!(await deps.runs.move(run.id, ['ready'], { status: 'running', phase: 'revising' }))) return
    const usage: RunUsage = { ...EMPTY_USAGE }
    const settle = (revisionError: string | null) =>
      deps.runs.move(run.id, ['running'], { status: 'ready', phase: null, revisionError })
    try {
      const caps = runCapsForRecipe(found.recipe, DEFAULT_RUN_CAPS)
      if (!caps.ok) return void (await settle(`run_${caps.code}`))
      const runner = budgetedRunner(deps.runner, {
        caps: caps.caps,
        price: null,
        rate: null,
        usage,
        startedAt: Date.now(),
      })
      const result = await reviseRecipeRun(
        runner,
        {
          recipe: found.recipe,
          gate: run.gate,
          previous: {
            document: storedDraft(revision.document),
            rows: revision.rows,
            verifications: revision.verifications,
            dataHash: revision.dataHash,
          },
          origin: 'pm_request',
          slots: job.slots,
          request: job.request,
          acceptances: run.acceptances,
          decisions: run.decisions,
        },
        engineDeps(deps, run, undefined),
      )
      if (!result.kept) {
        await settle(`revision_${result.reason}`)
        deps.logger.info('revision not kept', { runId: run.id, reason: result.reason })
        return
      }
      await deps.runs.saveRevision(run.id, {
        origin: 'pm_request',
        document: result.document,
        rows: result.rows,
        verifications: result.verifications,
        skeletonHash: result.result.skeletonHash,
        dataHash: result.result.dataHash,
      })
      await settle(null)
      deps.logger.info('revision kept', { runId: run.id, slots: job.slots.length })
    } catch (error) {
      const code = failureCode(error)
      await settle(code)
      deps.logger.error('revision failed', { runId: run.id, code })
    }
  }
}

/** A failure of the render with the code the PM is shown. */
class NoFile extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'NoFile'
    this.code = code
  }
}

/** A file made for an approval, before its bytes are stored. */
type MadeFile = Omit<NewDeliverableFile, 'blobKey'> & { bytes: Uint8Array }

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export interface RenderDependencies<Tx> extends RunWorkDependencies<Tx> {
  readonly blobs: BlobStore
  /** Absent when no renderer is configured: only the Markdown files are made. */
  readonly renderer?: Renderer | undefined
  readonly signal?: AbortSignal
}

/** The ids of the documents and facts the notes of a document cite. */
function citedIds(document: InternalDocument) {
  const evidenceIds = new Set<string>()
  const factIds = new Set<string>()
  for (const note of document.sourceNotes) {
    if (note.ref.kind === 'evidence') evidenceIds.add(note.ref.evidenceId)
    if (note.ref.kind === 'fact') factIds.add(note.ref.factId)
  }
  return { evidenceIds: [...evidenceIds], factIds: [...factIds] }
}

/**
 * Worker job: makes the files of an approved document. The internal file holds everything; the
 * client file (when the recipe has one) is the projection the audience gate allows, never the
 * internal document with pieces hidden by hand. Markdown is written here; a Word, PowerPoint or
 * Excel file is made by the isolated renderer from a template.
 */
export function createRenderDeliverableHandler<Tx>(deps: RenderDependencies<Tx>) {
  async function documentFor(
    details: RunDetails,
    recipe: LibraryRecipe['recipe'],
    internal: InternalDocument,
    audience: FileAudience,
  ): Promise<DeliverableDocument> {
    const lang = recipe.lang as Lang
    if (audience === 'internal') return fileDocument(internal, [], lang)
    const { run } = details
    if (!run.gate) throw new NoFile('client_version_changed')
    const cited = await deps.reading.withTx((tx) =>
      deps.reading.citedSources(tx, run.projectId as ProjectId, citedIds(internal)),
    )
    const context = runRedTeamContext({
      recipe,
      gate: run.gate,
      knownNames: [],
      cited,
      suspicious: {},
      declaredValues: [],
      verifications: {},
      acceptances: run.acceptances,
      decisions: run.decisions,
    })
    if (!context.client) throw new NoFile('client_version_changed')
    const { version } = projectClientVersion(internal, context.client.audience, run.acceptances)
    return fileDocument(version.document, [], lang)
  }

  async function filesOf(
    recipe: LibraryRecipe['recipe'],
    document: DeliverableDocument,
    audience: FileAudience,
  ): Promise<MadeFile[]> {
    const made = (format: RenderFormat, bytes: Uint8Array) => {
      const sha256 = sha256Of(bytes)
      return {
        audience,
        format,
        bytes,
        sha256,
        sizeBytes: bytes.length,
        fileName: deliverableFileName(document, audience, format),
      }
    }
    const files = [made('md', new TextEncoder().encode(renderMarkdown(document)))]
    const binary = binaryFormatOf(recipe.render)
    if (binary === null || !deps.renderer) return files
    const template = await templateOf(deps.templates, recipe)
    if (template === null) throw new NoFile('template_missing')
    const answer = await deps.renderer.render(
      renderEnvelope(document, binary, template.bytes, fileLayout(recipe.render, document)),
      deps.signal ?? new AbortController().signal,
    )
    if (answer.outcome === 'refused') throw new NoFile(renderFailureOf(answer.checks))
    const bytes = new Uint8Array(Buffer.from(answer.file, 'base64'))
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || sha256Of(bytes) !== answer.sha256) {
      throw new NoFile('file_check_failed')
    }
    files.push(made(binary, bytes))
    return files
  }

  return async ({ runId }: { runId: string }): Promise<void> => {
    const details = await deps.runs.load(runId)
    if (details?.run.approval !== 'approving' || !details.revision) return
    const { run, revision } = details
    try {
      const found = deps.library.get(run.recipeSlug)
      if (!found || found.hash !== run.recipeHash || !run.gate) throw new NoFile('render_error')
      const internal = storedDraft(revision.document)
      const files: MadeFile[] = []
      for (const audience of runFileAudiences(found.recipe, run.gate)) {
        const document = await documentFor(details, found.recipe, internal, audience)
        files.push(...(await filesOf(found.recipe, document, audience)))
      }
      const stored: NewDeliverableFile[] = []
      for (const { bytes, ...file } of files) {
        const { key } = await deps.blobs.put(run.projectId, bytes)
        stored.push({ ...file, blobKey: key })
      }
      await deps.runs.completeApproval(runId, stored)
      deps.logger.info('deliverable approved', {
        runId,
        files: files.map((file) => `${file.audience}.${file.format}`),
      })
    } catch (error) {
      const code =
        error instanceof NoFile
          ? error.code
          : error instanceof RendererUnavailable
            ? 'renderer_unavailable'
            : error instanceof DomainError
              ? error.code
              : UNEXPECTED_RENDER_FAILURE
      await deps.runs.failApproval(runId, code)
      deps.logger.error('deliverable render failed', { runId, code })
    }
  }
}
