import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptFinding,
  approveRun,
  createRenderDeliverableHandler,
  createReviseRunHandler,
  createRunRecipeHandler,
  type DeliverableDependencies,
  downloadFile,
  getRun,
  type RunReading,
  requestChange,
  startRun,
} from '@octobrief/application'
import {
  FakeRenderer,
  InMemoryBlobs,
  InMemoryJobQueue,
  RecordingLogger,
} from '@octobrief/application/testing'
import type { Classification, Extraction, User } from '@octobrief/domain'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeRunner } from '../src/model/fake-runner.ts'
import { answerStore, knowledgeReader, trackerReader } from '../src/postgres/ask-store.ts'
import {
  createDocumentProcessingStore,
  createDocumentRepository,
} from '../src/postgres/document-repository.ts'
import { runMigrations } from '../src/postgres/migrations.ts'
import { createPool } from '../src/postgres/pool.ts'
import { createProjectRepository } from '../src/postgres/project-repository.ts'
import { citedSources, recipeDataReader, suspiciousHits } from '../src/postgres/recipe-data.ts'
import { createRunRepository, createRunWorkStore } from '../src/postgres/run-store.ts'
import { inTransaction } from '../src/postgres/transaction.ts'
import { createUserRepository } from '../src/postgres/user-repository.ts'
import {
  createFileRecipeLibrary,
  createFileTemplateStore,
  InvalidRecipeFileError,
} from '../src/recipes/file-library.ts'

const { DATABASE_OWNER_URL, DATABASE_URL, DATABASE_WORKER_URL } = process.env
const hasDatabase = Boolean(DATABASE_OWNER_URL && DATABASE_URL && DATABASE_WORKER_URL)
const REPOSITORY = new URL('../../../', import.meta.url).pathname

const MAIL_PARAMETERS = {
  communication_type: { type: 'choice', value: 'decision_request' },
  facts: { type: 'text', value: 'Il collaudo del modulo è previsto per il 30 novembre 2026.' },
  request: { type: 'text', value: 'Confermare la data del collaudo' },
  request_owner: { type: 'text', value: 'Responsabile del cliente' },
  request_due: { type: 'date', day: '2026-11-20' },
} as const

describe('recipe library and templates on disk', () => {
  it('reads the recipes of the repository and refuses a file that is not a recipe', () => {
    const library = createFileRecipeLibrary(join(REPOSITORY, 'recipes'))
    expect(library.list().map(({ recipe }) => recipe.slug)).toEqual(
      expect.arrayContaining(['mail-cliente', 'sal-economico', 'verbale-da-trascritto']),
    )
    expect(library.get('mail-cliente')?.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(library.get('nessuna')).toBeNull()
    const broken = mkdtempSync(join(tmpdir(), 'octobrief-recipes-'))
    writeFileSync(join(broken, 'rotta.json'), JSON.stringify({ recipe: { slug: 'x' } }))
    expect(() => createFileRecipeLibrary(broken)).toThrow(InvalidRecipeFileError)
  })

  it('finds a template by its slug and format, never by a path', async () => {
    const templates = createFileTemplateStore(join(REPOSITORY, 'templates'))
    const sal = await templates.find('modulo-sal')
    expect(sal).toMatchObject({ slug: 'modulo-sal', format: 'xlsx' })
    expect(sal?.contentHash).toBe(
      `sha256:${createHash('sha256')
        .update(sal?.bytes as Uint8Array)
        .digest('hex')}`,
    )
    expect(await templates.find('neutro-docx')).toMatchObject({ format: 'docx' })
    expect(await templates.find('inesistente')).toBeNull()
    expect(await templates.find('../recipes/client-mail')).toBeNull()
  })
})

describe.skipIf(!hasDatabase)('deliverables on Postgres with the fake model (integration)', () => {
  const pool = createPool(DATABASE_URL as string, 'octobrief-test', 2)
  const workerPool = createPool(DATABASE_WORKER_URL as string, 'octobrief-test-worker', 2)
  const users = createUserRepository(pool)
  const projects = createProjectRepository(pool)
  const documents = createDocumentRepository(pool)
  const library = createFileRecipeLibrary(join(REPOSITORY, 'recipes'))
  const templates = createFileTemplateStore(join(REPOSITORY, 'templates'))
  const runs = createRunRepository(pool)
  const work = createRunWorkStore(workerPool)
  const blobs = new InMemoryBlobs()
  const queue = new InMemoryJobQueue()
  const logger = new RecordingLogger()
  const run = randomUUID().slice(0, 8)
  const reading: RunReading<pg.PoolClient> = {
    data: recipeDataReader,
    reader: knowledgeReader,
    store: answerStore,
    tracker: trackerReader,
    citedSources,
    suspicious: suspiciousHits,
    withTx: (fn) => inTransaction(workerPool, fn),
  }
  const making = (inventInDrafts: boolean) => ({
    runs: work,
    library,
    reading,
    templates,
    runner: fakeRunner({ inventInDrafts }),
    logger,
  })
  let paola: User
  let marco: User
  let deps: DeliverableDependencies
  let slug: string
  let projectId: string

  const person = (tag: string) =>
    users.upsertFromLogin(
      {
        externalSubject: `https://issuer.test|run-${tag}-${run}`,
        displayName: `Person ${tag}`,
        email: `run-${tag}-${run}@example.test`,
        emailVerified: true,
      },
      false,
    )

  beforeAll(async () => {
    await runMigrations(DATABASE_OWNER_URL as string)
    paola = await person('paola')
    marco = await person('marco')
    slug = `run-${run}`
    const project = await projects.create({
      slug,
      name: `Runs ${run}`,
      client: null,
      ownerId: paola.id,
    })
    projectId = project.id
    deps = { users, projects, library, runs, blobs, queue }
  })

  afterAll(async () => {
    await pool.end()
    await workerPool.end()
  })

  it('writes a draft, rewrites the text the PM names, and makes the files at approval', async () => {
    const started = await startRun(deps, paola, slug, {
      recipeSlug: 'mail-cliente',
      parameters: MAIL_PARAMETERS,
    })
    await createRunRecipeHandler(making(true))({ runId: started.id })

    const draft = await getRun(deps, paola, slug, started.id)
    expect(draft.run).toMatchObject({ status: 'ready', phase: null, errorCode: null })
    expect(draft.revision).toBe(1)
    expect(draft.document?.sections.map((section) => section.id)).toEqual([
      'subject',
      'body',
      'pm_notes',
    ])
    const invented = draft.findings.find((finding) => finding.code === 'without_source')
    expect(invented).toMatchObject({ status: 'open', acceptable: false, slot: 'subject_line' })
    expect(invented?.text).toContain('123.456')
    expect(draft.approvable).toBe(false)
    await expect(approveRun(deps, paola, slug, started.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    // A second delivery of the job does nothing: the run is no longer queued.
    await createRunRecipeHandler(making(true))({ runId: started.id })
    expect((await getRun(deps, paola, slug, started.id)).revision).toBe(1)

    await requestChange(deps, paola, slug, started.id, {
      slots: ['subject_line'],
      request: 'Togli la cifra che non viene dai documenti.',
    })
    const revise = [...queue.jobs.values()].at(-1) as {
      data: { runId: string; slots: string[]; request: string }
    }
    await createReviseRunHandler(making(true))(revise.data)
    const revised = await getRun(deps, paola, slug, started.id)
    expect(revised.revision).toBe(2)
    expect(revised.run.revisionError).toBeNull()
    expect(revised.findings.some((finding) => finding.text.includes('123.456'))).toBe(false)
    for (const finding of revised.findings.filter((f) => f.status === 'open')) {
      expect(finding.acceptable).toBe(true)
      await acceptFinding(deps, paola, slug, started.id, {
        code: finding.code,
        refKey: finding.refKey,
        reason: 'Controllato a mano prima di inviare la mail al cliente.',
      })
    }
    expect((await getRun(deps, paola, slug, started.id)).approvable).toBe(true)

    await approveRun(deps, paola, slug, started.id)
    await createRenderDeliverableHandler({ ...making(false), blobs })({ runId: started.id })
    const approved = await getRun(deps, paola, slug, started.id)
    expect(approved.run).toMatchObject({ approval: 'approved', approvalError: null })
    expect(approved.files.map((file) => [file.audience, file.format])).toEqual([['client', 'md']])
    const file = approved.files[0] as (typeof approved.files)[number]
    const { bytes } = await downloadFile(deps, paola, slug, started.id, file.id)
    const markdown = new TextDecoder().decode(bytes)
    expect(markdown).toContain('# Mail al cliente')
    expect(markdown).toContain('Confermare la data del collaudo')
    expect(markdown).not.toContain('123.456')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
  })

  it('makes the binary file through the renderer, and says when it cannot', async () => {
    const order = await documents.create(paola.id, {
      projectId,
      fileName: 'Ordine-OA-26-464.md',
      mediaType: 'text/markdown',
      sizeBytes: 42,
      sha256: randomUUID().replaceAll('-', '').repeat(2),
      blobKey: `${projectId}/order`,
      uploadedBy: paola.id,
    })
    const extraction: Extraction = {
      extractor: 'test/1',
      chunks: [
        { locator: { kind: 'line', from: 1, to: 1 }, text: 'Ordine OA-26-464 del 2 marzo 2026' },
      ],
      truncated: false,
      metadataDate: null,
      warnings: [],
    }
    const classification: Classification = {
      kind: 'purchase_order',
      audience: 'client',
      audienceSource: 'pm',
      dateOf: { date: new Date('2026-03-02T00:00:00Z'), source: 'file_name' },
      uncertain: [],
    }
    await createDocumentProcessingStore(workerPool).markReady(
      order?.id as string,
      extraction,
      classification,
    )
    const started = await startRun(deps, paola, slug, {
      recipeSlug: 'sal-economico',
      parameters: {
        period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
        order_doc: { type: 'evidence_selection', evidenceIds: [order?.id as string] },
        order_number: { type: 'text', value: 'OA-26-464' },
        order_date: { type: 'date', day: '2026-03-02' },
        order_total: { type: 'number', value: 1000 },
        positions: {
          type: 'rows',
          rows: [
            {
              position: '1',
              item: 'Analisi',
              amount: 1000,
              request: 1,
              previous_pct: 0,
              current_pct: 50,
            },
          ],
        },
        requests: { type: 'rows', rows: [{ number: 1, amount: 500 }] },
      },
    })
    await createRunRecipeHandler(making(false))({ runId: started.id })
    const draft = await getRun(deps, paola, slug, started.id)
    expect(draft.run.status).toBe('ready')
    for (const finding of draft.findings.filter((f) => f.status === 'open')) {
      expect(finding.acceptable).toBe(true)
      await acceptFinding(deps, paola, slug, started.id, {
        code: finding.code,
        refKey: finding.refKey,
        reason: 'Il warehouse non è collegato a questo progetto di prova.',
      })
    }

    // The renderer refuses: the approval fails with the reason and can be asked again.
    await approveRun(deps, paola, slug, started.id)
    const refusing = new FakeRenderer(() => ({
      outcome: 'refused',
      checks: [{ subject: 'file', check: 'counts', passed: false, findings: ['count_mismatch'] }],
    }))
    await createRenderDeliverableHandler({ ...making(false), blobs, renderer: refusing })({
      runId: started.id,
    })
    expect((await getRun(deps, paola, slug, started.id)).run).toMatchObject({
      approval: 'render_failed',
      approvalError: 'count_mismatch',
    })
    expect(refusing.envelopes[0]).toMatchObject({ format: 'xlsx' })

    await approveRun(deps, paola, slug, started.id)
    const xlsx = new Uint8Array([0x50, 0x4b, 3, 4])
    const rendering = new FakeRenderer(() => ({
      outcome: 'rendered',
      file: Buffer.from(xlsx).toString('base64'),
      sha256: createHash('sha256').update(xlsx).digest('hex'),
      checks: [],
    }))
    await createRenderDeliverableHandler({ ...making(false), blobs, renderer: rendering })({
      runId: started.id,
    })
    const approved = await getRun(deps, paola, slug, started.id)
    expect(approved.run.approval).toBe('approved')
    expect(approved.files.map((file) => `${file.audience}.${file.format}`)).toEqual([
      'client.md',
      'client.xlsx',
    ])
    expect(approved.files[1]?.fileName).toBe('sal-economico-1.0.0-cliente.xlsx')
  })

  it('records why a run fails, and hides runs from who does not see the project', async () => {
    const started = await startRun(deps, paola, slug, {
      recipeSlug: 'mail-cliente',
      parameters: { communication_type: { type: 'choice', value: 'inesistente' } },
    })
    await createRunRecipeHandler(making(false))({ runId: started.id })
    expect((await getRun(deps, paola, slug, started.id)).run).toMatchObject({
      status: 'failed',
      errorCode: 'recipe_parameter_invalid',
    })
    expect(await runs.find(marco.id, projectId, started.id)).toBeNull()
    expect(await runs.list(marco.id, projectId)).toEqual([])
    await expect(
      runs.create(marco.id, {
        projectId,
        recipeSlug: 'mail-cliente',
        recipeVersion: '1.0.0',
        recipeHash: 'sha256:x',
        parameters: {},
      }),
    ).rejects.toThrow(/row-level security/)
    await runs.discard(paola.id, started.id)
    expect((await runs.list(paola.id, projectId)).map((r) => r.id)).not.toContain(started.id)
    // Jobs for runs that are gone, or in another state, do nothing.
    await createRunRecipeHandler(making(false))({ runId: randomUUID() })
    await createReviseRunHandler(making(false))({ runId: started.id, slots: ['x'], request: 'y' })
    await createRenderDeliverableHandler({ ...making(false), blobs })({ runId: started.id })
  })
})
