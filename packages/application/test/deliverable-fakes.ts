import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type ParameterValues,
  type RenderEnvelope,
  type RenderResponse,
  recipeHash,
  validateRecipe,
} from '@octobrief/domain/recipe'
import type {
  DeliverableFile,
  LibraryRecipe,
  NewDeliverableFile,
  NewRevision,
  RecipeLibrary,
  Renderer,
  RunDetails,
  RunRecord,
  RunRepository,
  RunRevision,
  RunWorkStore,
  Template,
  TemplateStore,
} from '../src/ports/deliverable-stores.ts'
import type { InMemoryDocuments } from './fakes.ts'

const RECIPES_DIR = fileURLToPath(new URL('../../../recipes/', import.meta.url))

/** The product recipes of the repository, validated as the library does at start. */
export function repositoryLibrary(): RecipeLibrary {
  const recipes = new Map<string, LibraryRecipe>()
  for (const file of readdirSync(RECIPES_DIR).filter((name) => name.endsWith('.json'))) {
    const checked = validateRecipe(JSON.parse(readFileSync(RECIPES_DIR + file, 'utf8')).recipe)
    if (!checked.ok) throw new Error(`invalid recipe ${file}`)
    recipes.set(checked.recipe.slug, { recipe: checked.recipe, hash: recipeHash(checked.recipe) })
  }
  return { list: () => [...recipes.values()], get: (slug) => recipes.get(slug) ?? null }
}

interface StoredRun {
  run: RunRecord
  revisions: RunRevision[]
  files: DeliverableFile[]
}

/** Both views of the runs, over the in-memory documents (which stand in for row-level security). */
export class InMemoryRuns implements RunRepository, RunWorkStore {
  readonly rows = new Map<string, StoredRun>()
  private readonly documents: InMemoryDocuments
  private clock = Date.parse('2026-11-12T09:00:00Z')
  constructor(documents: InMemoryDocuments) {
    this.documents = documents
  }
  private patch(runId: string, change: Partial<RunRecord>) {
    const row = this.rows.get(runId)
    if (row) row.run = { ...row.run, ...change }
  }
  private details(row: StoredRun): RunDetails {
    return { run: row.run, revision: row.revisions.at(-1) ?? null, files: row.files }
  }
  async create(
    viewerId: string,
    run: {
      projectId: string
      recipeSlug: string
      recipeVersion: string
      recipeHash: string
      parameters: ParameterValues
    },
  ) {
    if (!this.documents.visible(viewerId, run.projectId)) throw new Error('row-level security')
    this.clock += 1000
    const created: RunRecord = {
      id: randomUUID(),
      ...run,
      requestedBy: viewerId,
      status: 'queued',
      phase: null,
      errorCode: null,
      revisionError: null,
      gate: null,
      acceptances: [],
      decisions: [],
      approval: null,
      approvalError: null,
      approvedAt: null,
      createdAt: new Date(this.clock),
    }
    this.rows.set(created.id, { run: created, revisions: [], files: [] })
    return created
  }
  async list(viewerId: string, projectId: string) {
    if (!this.documents.visible(viewerId, projectId)) return []
    return [...this.rows.values()]
      .map((row) => row.run)
      .filter((run) => run.projectId === projectId && run.status !== 'discarded')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }
  async find(viewerId: string, projectId: string, runId: string) {
    const row = this.rows.get(runId)
    if (!row || row.run.projectId !== projectId || !this.documents.visible(viewerId, projectId)) {
      return null
    }
    return this.details(row)
  }
  async saveJudgements(
    _viewerId: string,
    runId: string,
    judgements: Pick<RunRecord, 'acceptances' | 'decisions'>,
  ) {
    this.patch(runId, judgements)
  }
  async requestApproval(_viewerId: string, runId: string) {
    const run = this.rows.get(runId)?.run
    if (run?.status !== 'ready' || run.approval === 'approving' || run.approval === 'approved') {
      return false
    }
    this.patch(runId, { approval: 'approving', approvalError: null })
    return true
  }
  async discard(_viewerId: string, runId: string) {
    this.patch(runId, { status: 'discarded' })
  }
  async load(runId: string) {
    const row = this.rows.get(runId)
    return row ? this.details(row) : null
  }
  async move(
    runId: string,
    from: readonly RunRecord['status'][],
    change: Parameters<RunWorkStore['move']>[2],
  ) {
    const run = this.rows.get(runId)?.run
    if (!run || !from.includes(run.status)) return false
    const { usage: _usage, ...rest } = change
    this.patch(runId, rest as Partial<RunRecord>)
    return true
  }
  async saveSnapshot(runId: string, _snapshot: unknown, gate: RunRecord['gate']) {
    this.patch(runId, { gate })
  }
  async saveRevision(runId: string, revision: NewRevision) {
    const row = this.rows.get(runId)
    if (!row) return
    row.revisions.push({
      ...revision,
      seq: row.revisions.length + 1,
      createdAt: new Date(this.clock),
    })
  }
  async completeApproval(runId: string, files: readonly NewDeliverableFile[]) {
    const row = this.rows.get(runId)
    if (!row) return
    row.files = files.map((file) => ({ ...file, id: randomUUID() }))
    this.patch(runId, { approval: 'approved', approvedAt: new Date(this.clock) })
  }
  async failApproval(runId: string, code: string) {
    this.patch(runId, { approval: 'render_failed', approvalError: code })
  }
}

/** Templates given by the test, by slug. */
export class FakeTemplates implements TemplateStore {
  readonly templates = new Map<string, Template>()
  async find(slug: string) {
    return this.templates.get(slug) ?? null
  }
}

/** A renderer that answers what the test says and remembers what it was asked. */
export class FakeRenderer implements Renderer {
  readonly envelopes: RenderEnvelope[] = []
  answer: (envelope: RenderEnvelope) => RenderResponse | Promise<RenderResponse>
  constructor(answer: FakeRenderer['answer']) {
    this.answer = answer
  }
  async render(envelope: RenderEnvelope) {
    this.envelopes.push(envelope)
    return this.answer(envelope)
  }
}
