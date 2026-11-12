import type { User } from '@octobrief/domain'
import type { RedTeamRow } from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { ApplicationError } from '../src/errors.ts'
import {
  acceptFinding,
  approveRun,
  downloadFile,
  getRun,
  listRecipes,
  listRuns,
  requestChange,
  startRun,
} from '../src/use-cases/deliverables.ts'
import { addMember, createProject } from '../src/use-cases/projects.ts'
import { InMemoryRuns, repositoryLibrary } from './deliverable-fakes.ts'
import {
  InMemoryBlobs,
  InMemoryDocuments,
  InMemoryJobQueue,
  InMemoryProjects,
  InMemoryUsers,
} from './fakes.ts'

const MAIL_PARAMETERS = {
  communication_type: { type: 'choice', value: 'update' },
  request: { type: 'text', value: 'Confermare la data' },
  request_owner: { type: 'text', value: 'Responsabile' },
  request_due: { type: 'date', day: '2026-11-20' },
} as const

const place = { section: 'Testo della mail', block: 'Contesto' }
const ref = (segment: string) =>
  JSON.stringify({ block: 'context', element: 'segment', section: 'body', segment })

/** Rows as the red team stores them: one tally of checks, two anomalies, one warning. */
const ROWS: RedTeamRow[] = [
  {
    code: 'gate_1',
    class: 'data',
    outcome: 'checked',
    acceptable: false,
    ref: '',
    contentHash: '',
    detail: { count: 40 },
  },
  {
    code: 'without_source',
    class: 'data',
    outcome: 'anomaly',
    acceptable: false,
    ref: ref('sha256:aa'),
    contentHash: 'sha256:11',
    detail: { gate: 1, slot: 'context', place, excerpt: 'Il totale è 123.456 euro.' },
  },
  {
    code: 'recipe_check_not_evaluable',
    class: 'data',
    outcome: 'anomaly',
    acceptable: true,
    ref: JSON.stringify({ element: 'check', check: 'closing' }),
    contentHash: 'sha256:22',
    detail: { check: 'closing', title: 'chiusura senza residui' },
  },
  {
    code: 'old_snapshot',
    class: 'data',
    outcome: 'warning',
    acceptable: false,
    ref: JSON.stringify({ element: 'document' }),
    contentHash: 'sha256:33',
    detail: {},
  },
]

const DOCUMENT = {
  schema: 'octobrief.document/1',
  recipe: { slug: 'mail-cliente', version: '1.0.0' },
  lang: 'it',
  title: 'Mail al cliente',
  audience: 'internal',
  header: { dataAsOf: null, generatedAt: '2026-11-12T09:00:00.000Z' },
  sections: [],
  sourceNotes: [],
  internalNotes: [],
}

async function setup() {
  const users = new InMemoryUsers()
  const projects = new InMemoryProjects(users)
  const documents = new InMemoryDocuments(projects, users)
  const runs = new InMemoryRuns(documents)
  const blobs = new InMemoryBlobs()
  const queue = new InMemoryJobQueue()
  const library = repositoryLibrary()
  const deps = {
    users,
    projects,
    library,
    runs,
    blobs,
    queue,
    now: () => new Date('2026-11-12T10:00:00Z'),
  }
  const person = (id: string, role: User['role'] = 'pm'): User =>
    users.add({ id, displayName: id, email: `${id}@example.test`, role, locale: 'it' })
  const paola = person('paola')
  const marco = person('marco')
  const olga = person('olga')
  const alba = person('alba', 'admin')
  const project = await createProject(deps, paola, { name: 'Aurora' })
  await addMember(deps, paola, project.slug, 'marco@example.test')
  const start = (viewer: User = marco) =>
    startRun(deps, viewer, project.slug, {
      recipeSlug: 'mail-cliente',
      parameters: MAIL_PARAMETERS,
    })
  /** A run whose first draft is written and waits for the PM. */
  const ready = async (viewer: User = marco) => {
    const run = await start(viewer)
    await runs.saveRevision(run.id, {
      origin: 'writer',
      document: DOCUMENT,
      rows: ROWS,
      verifications: {},
      skeletonHash: 'sha256:s',
      dataHash: 'sha256:d',
    })
    await runs.move(run.id, ['queued'], { status: 'ready' })
    return run
  }
  const jobs = () => [...queue.jobs.values()].map((job) => job.name)
  return {
    deps,
    runs,
    blobs,
    queue,
    library,
    project,
    paola,
    marco,
    olga,
    alba,
    start,
    ready,
    jobs,
  }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof ApplicationError) return error.code
      throw error
    },
  )

describe('the catalog and the start of a run', () => {
  it('offers the recipes of the library and queues a run of one', async () => {
    const { deps, start, jobs, marco, olga, project } = await setup()
    expect(listRecipes(deps).map(({ recipe }) => recipe.slug)).toEqual(
      expect.arrayContaining(['mail-cliente', 'sal-economico']),
    )
    const run = await start()
    expect(run).toMatchObject({
      recipeSlug: 'mail-cliente',
      status: 'queued',
      requestedBy: marco.id,
    })
    expect(run.recipeHash).toMatch(/^sha256:/)
    expect(jobs()).toEqual(['deliverable.run'])
    expect(await listRuns(deps, marco, project.slug)).toMatchObject([
      { id: run.id, recipeTitle: 'Mail al cliente' },
    ])
    expect(
      await code(startRun(deps, marco, project.slug, { recipeSlug: 'nessuna', parameters: {} })),
    ).toBe('not_found')
    expect(
      await code(
        startRun(deps, olga, project.slug, { recipeSlug: 'mail-cliente', parameters: {} }),
      ),
    ).toBe('not_found')
  })

  it('shows a run before its document exists', async () => {
    const { deps, start, marco, project } = await setup()
    const run = await start()
    expect(await getRun(deps, marco, project.slug, run.id)).toMatchObject({
      document: null,
      revision: 0,
      findings: [],
      summary: null,
      approvable: false,
    })
    expect(await code(getRun(deps, marco, project.slug, crypto.randomUUID()))).toBe('not_found')
  })
})

describe('reviewing a draft', () => {
  it('shows the findings with their words, place and state, and whether it can be approved', async () => {
    const { deps, ready, marco, project } = await setup()
    const run = await ready()
    const view = await getRun(deps, marco, project.slug, run.id)
    expect(view.revision).toBe(1)
    expect(view.summary).toMatchObject({ checks: 40, anomalies: 2, open: 2, warnings: 1 })
    expect(view.findings.map((f) => [f.kind, f.code, f.status, f.acceptable, f.slot])).toEqual([
      ['anomaly', 'without_source', 'open', false, 'context'],
      ['anomaly', 'recipe_check_not_evaluable', 'open', true, null],
      ['warning', 'old_snapshot', null, false, null],
    ])
    expect(view.findings[0]).toMatchObject({ place, excerpt: 'Il totale è 123.456 euro.' })
    expect(view.findings[0]?.text).toContain('Testo della mail')
    expect(view.approvable).toBe(false)
  })

  it('accepts an anomaly that may be accepted, with a reason, and nothing else', async () => {
    const { deps, ready, marco, project } = await setup()
    const run = await ready()
    const closing = ROWS[2] as RedTeamRow
    const accept = (codeOf: string, refKey: string, reason: string) =>
      acceptFinding(deps, marco, project.slug, run.id, { code: codeOf, refKey, reason })
    const reason = 'Il DWSI non è collegato: i residui si controllano a mano.'
    expect(await code(accept(closing.code, closing.ref, 'ok'))).toBe('invalid')
    expect(await code(accept('without_source', (ROWS[1] as RedTeamRow).ref, reason))).toBe(
      'invalid',
    )
    expect(await code(accept('sconosciuta', 'x', reason))).toBe('not_found')

    const view = await accept(closing.code, closing.ref, reason)
    expect(view.findings[1]).toMatchObject({ status: 'accepted' })
    expect(view.summary).toMatchObject({ open: 1, accepted: 1 })
    const stored = await getRun(deps, marco, project.slug, run.id)
    expect(stored.run.acceptances).toMatchObject([
      { code: closing.code, by: marco.id, at: '2026-11-12T10:00:00.000Z', reason },
    ])
    // Already accepted: there is no open anomaly with that reference any more.
    expect(await code(accept(closing.code, closing.ref, reason))).toBe('not_found')
  })

  it('queues a change of the texts the PM names, with what to change', async () => {
    const { deps, ready, marco, project, queue } = await setup()
    const run = await ready()
    const change = (slots: string[], request: string) =>
      requestChange(deps, marco, project.slug, run.id, { slots, request })
    expect(await code(change([], 'Togli la cifra'))).toBe('invalid')
    expect(await code(change(['context'], '   '))).toBe('invalid')
    await change(['context'], ' Togli la cifra ')
    expect([...queue.jobs.values()].at(-1)).toMatchObject({
      name: 'deliverable.revise',
      data: { runId: run.id, slots: ['context'], request: 'Togli la cifra' },
    })
  })

  it('lets only who asked, owners and admins decide; members read', async () => {
    const { deps, ready, runs, paola, marco, alba, project } = await setup()
    const run = await ready(paola)
    const closing = ROWS[2] as RedTeamRow
    const input = {
      code: closing.code,
      refKey: closing.ref,
      reason: 'Una motivazione abbastanza lunga.',
    }
    expect(await getRun(deps, marco, project.slug, run.id)).toMatchObject({ revision: 1 })
    expect(await code(acceptFinding(deps, marco, project.slug, run.id, input))).toBe('forbidden')
    expect(await code(approveRun(deps, marco, project.slug, run.id))).toBe('forbidden')
    await acceptFinding(deps, alba, project.slug, run.id, input)
    // A run that is not waiting for a decision takes none.
    await runs.move(run.id, ['ready'], { status: 'running' })
    expect(await code(acceptFinding(deps, paola, project.slug, run.id, input))).toBe('conflict')
  })
})

describe('approval and files', () => {
  it('refuses the approval while an anomaly is open, then records it once', async () => {
    const { deps, ready, runs, marco, project, jobs } = await setup()
    const run = await ready()
    expect(await code(approveRun(deps, marco, project.slug, run.id))).toBe('conflict')
    // The change removed the unsupported text: only the acceptable anomaly is left.
    await runs.saveRevision(run.id, {
      origin: 'pm_request',
      document: DOCUMENT,
      rows: [ROWS[0] as RedTeamRow, ROWS[2] as RedTeamRow],
      verifications: {},
      skeletonHash: 'sha256:s',
      dataHash: 'sha256:d',
    })
    const closing = ROWS[2] as RedTeamRow
    await acceptFinding(deps, marco, project.slug, run.id, {
      code: closing.code,
      refKey: closing.ref,
      reason: 'Il DWSI non è collegato a questo progetto.',
    })
    expect((await getRun(deps, marco, project.slug, run.id)).approvable).toBe(true)
    await approveRun(deps, marco, project.slug, run.id)
    expect(jobs().at(-1)).toBe('deliverable.render')
    expect((await getRun(deps, marco, project.slug, run.id)).run.approval).toBe('approving')
    expect(await code(approveRun(deps, marco, project.slug, run.id))).toBe('conflict')
  })

  it('gives the files of an approved run to who sees the project', async () => {
    const { deps, ready, runs, blobs, marco, olga, project } = await setup()
    const run = await ready()
    const bytes = new TextEncoder().encode('# Mail al cliente')
    const { key, sha256 } = await blobs.put(project.id, bytes)
    await runs.completeApproval(run.id, [
      {
        audience: 'client',
        format: 'md',
        fileName: 'mail-cliente.md',
        sha256,
        sizeBytes: bytes.length,
        blobKey: key,
      },
    ])
    const view = await getRun(deps, marco, project.slug, run.id)
    expect(view.files).toMatchObject([{ fileName: 'mail-cliente.md', audience: 'client' }])
    const fileId = view.files[0]?.id as string
    const download = await downloadFile(deps, marco, project.slug, run.id, fileId)
    expect(new TextDecoder().decode(download.bytes)).toBe('# Mail al cliente')
    expect(await code(downloadFile(deps, marco, project.slug, run.id, crypto.randomUUID()))).toBe(
      'not_found',
    )
    expect(await code(downloadFile(deps, olga, project.slug, run.id, fileId))).toBe('not_found')
  })
})
