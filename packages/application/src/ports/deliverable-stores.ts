import type {
  Acceptance,
  FileAudience,
  InputSnapshot,
  ParameterValues,
  PmDecision,
  Recipe,
  RedTeamRow,
  RenderEnvelope,
  RenderFormat,
  RenderResponse,
  RevisionOrigin,
  RunGateContext,
  RunPhase,
  RunStatus,
  TemplateFormat,
} from '@octobrief/domain/recipe'

/** A recipe of the library with its fingerprint. */
export interface LibraryRecipe {
  readonly recipe: Recipe
  readonly hash: string
}

/** The recipes this installation offers: validated when read, never changed at run time. */
export interface RecipeLibrary {
  list(): readonly LibraryRecipe[]
  get(slug: string): LibraryRecipe | null
}

export const APPROVAL_STATES = ['approving', 'approved', 'render_failed'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

export interface RunRecord {
  readonly id: string
  readonly projectId: string
  readonly requestedBy: string
  readonly recipeSlug: string
  readonly recipeVersion: string
  readonly recipeHash: string
  readonly parameters: ParameterValues
  readonly status: RunStatus
  readonly phase: RunPhase | null
  /** Stable codes: why the run failed, why the last requested change was not kept. */
  readonly errorCode: string | null
  readonly revisionError: string | null
  readonly gate: RunGateContext | null
  readonly acceptances: readonly Acceptance[]
  readonly decisions: readonly PmDecision[]
  readonly approval: ApprovalState | null
  readonly approvalError: string | null
  readonly approvedAt: Date | null
  readonly createdAt: Date
}

export interface RunRevision {
  readonly seq: number
  readonly origin: RevisionOrigin
  /** The internal document as stored; read back through `storedDraft`. */
  readonly document: unknown
  readonly rows: readonly RedTeamRow[]
  readonly verifications: unknown
  readonly skeletonHash: string
  readonly dataHash: string
  readonly createdAt: Date
}

export interface DeliverableFile {
  readonly id: string
  readonly audience: FileAudience
  readonly format: RenderFormat
  readonly fileName: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly blobKey: string
}

export interface RunDetails {
  readonly run: RunRecord
  /** The last revision; null until the first draft is written. */
  readonly revision: RunRevision | null
  readonly files: readonly DeliverableFile[]
}

/** Runs as a signed-in person sees them: every call runs as `viewerId`. */
export interface RunRepository {
  create(
    viewerId: string,
    run: {
      projectId: string
      recipeSlug: string
      recipeVersion: string
      recipeHash: string
      parameters: ParameterValues
    },
  ): Promise<RunRecord>
  list(viewerId: string, projectId: string): Promise<RunRecord[]>
  find(viewerId: string, projectId: string, runId: string): Promise<RunDetails | null>
  saveJudgements(
    viewerId: string,
    runId: string,
    judgements: { acceptances: readonly Acceptance[]; decisions: readonly PmDecision[] },
  ): Promise<void>
  /** Marks a ready run as being approved; false when it is no longer ready or already asked. */
  requestApproval(viewerId: string, runId: string): Promise<boolean>
  discard(viewerId: string, runId: string): Promise<void>
}

export interface NewRevision {
  readonly origin: RevisionOrigin
  readonly document: unknown
  readonly rows: readonly RedTeamRow[]
  readonly verifications: unknown
  readonly skeletonHash: string
  readonly dataHash: string
}

export interface NewDeliverableFile {
  readonly audience: FileAudience
  readonly format: RenderFormat
  readonly fileName: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly blobKey: string
}

/** The worker's view of the runs. */
export interface RunWorkStore {
  load(runId: string): Promise<RunDetails | null>
  /** Moves the run when it is in one of `from`; false when it was not (someone else moved it). */
  move(
    runId: string,
    from: readonly RunStatus[],
    change: {
      status?: RunStatus
      phase?: RunPhase | null
      errorCode?: string | null
      revisionError?: string | null
      usage?: unknown
    },
  ): Promise<boolean>
  saveSnapshot(
    runId: string,
    snapshot: { snapshot: InputSnapshot; hash: string },
    gate: RunGateContext,
  ): Promise<void>
  saveRevision(runId: string, revision: NewRevision): Promise<void>
  /** Stores the files of an approval and marks the run approved, all or nothing. */
  completeApproval(runId: string, files: readonly NewDeliverableFile[]): Promise<void>
  failApproval(runId: string, code: string): Promise<void>
}

/** A template a binary file is made from. */
export interface Template {
  readonly slug: string
  readonly format: TemplateFormat
  readonly bytes: Uint8Array
  readonly contentHash: string
}

export interface TemplateStore {
  find(slug: string): Promise<Template | null>
}

/** Makes a binary file (Word, PowerPoint, Excel) from a document and a template, in isolation. */
export interface Renderer {
  render(envelope: RenderEnvelope, signal: AbortSignal): Promise<RenderResponse>
}

/** The renderer did not answer: the approval can be asked again later. */
export class RendererUnavailable extends Error {
  constructor() {
    super('the renderer did not answer')
    this.name = 'RendererUnavailable'
  }
}
