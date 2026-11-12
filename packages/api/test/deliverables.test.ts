import type { InMemoryBlobs, InMemoryRuns } from '@octobrief/application/testing'
import { describe, expect, it } from 'vitest'
import { setup } from './support.ts'

const BASE = '/api/projects/aurora/runs'
const PARAMETERS = {
  communication_type: { type: 'choice', value: 'update' },
  request: { type: 'text', value: 'Confermare la data' },
  request_owner: { type: 'text', value: 'Responsabile' },
  request_due: { type: 'date', day: '2026-11-20' },
}
const ANOMALY = {
  code: 'recipe_check_not_evaluable',
  class: 'data',
  outcome: 'anomaly' as const,
  acceptable: true,
  ref: JSON.stringify({ element: 'check', check: 'closing' }),
  contentHash: 'sha256:22',
  detail: { check: 'closing', title: 'chiusura senza residui' },
}
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

async function project() {
  const context = setup()
  const paola = await context.signIn()
  await context.send('/api/projects', 'POST', paola, { name: 'Aurora' })
  const runs = context.deps.runs as InMemoryRuns
  const start = async () => {
    const response = await context.send(BASE, 'POST', paola, {
      recipeSlug: 'mail-cliente',
      parameters: PARAMETERS,
    })
    return (await response.json()) as { id: string; status: string; recipeTitle: string }
  }
  const ready = async () => {
    const run = await start()
    await runs.saveRevision(run.id, {
      origin: 'writer',
      document: DOCUMENT,
      rows: [ANOMALY],
      verifications: {},
      skeletonHash: 'sha256:s',
      dataHash: 'sha256:d',
    })
    await runs.move(run.id, ['queued'], { status: 'ready' })
    return run
  }
  return { ...context, paola, runs, start, ready }
}

describe('deliverables API', () => {
  it('lists the recipes with what their form asks', async () => {
    const { paola, send, api } = await project()
    const response = await send('/api/recipes', 'GET', paola)
    const { recipes } = (await response.json()) as {
      recipes: Array<{ slug: string; formats: string[]; parameters: Array<{ id: string }> }>
    }
    const mail = recipes.find((recipe) => recipe.slug === 'mail-cliente')
    expect(mail).toMatchObject({ title: 'Mail al cliente', audience: 'client', formats: ['md'] })
    expect(mail?.parameters.map((parameter) => parameter.id)).toContain('request')
    expect((await api.request('/api/recipes')).status).toBe(401)
  })

  it('starts a run, shows it and refuses an unknown recipe', async () => {
    const { paola, send, start } = await project()
    const run = await start()
    expect(run).toMatchObject({ status: 'queued', recipeTitle: 'Mail al cliente' })
    const list = (await (await send(BASE, 'GET', paola)).json()) as { runs: unknown[] }
    expect(list.runs).toMatchObject([{ id: run.id, approval: null, phase: null }])
    const view = await send(`${BASE}/${run.id}`, 'GET', paola)
    expect(await view.json()).toMatchObject({ document: null, revision: 0, approvable: false })
    const unknown = await send(BASE, 'POST', paola, { recipeSlug: 'nessuna', parameters: {} })
    expect(unknown.status).toBe(404)
  })

  it('accepts an anomaly with a reason, asks a change and approves', async () => {
    const { paola, send, ready, deps } = await project()
    const run = await ready()
    const view = (await (await send(`${BASE}/${run.id}`, 'GET', paola)).json()) as {
      findings: Array<{ code: string; refKey: string; status: string; text: string }>
      approvable: boolean
    }
    expect(view.findings).toMatchObject([{ code: ANOMALY.code, status: 'open', acceptable: true }])
    expect(view.approvable).toBe(false)
    expect((await send(`${BASE}/${run.id}/approval`, 'POST', paola)).status).toBe(409)

    const finding = view.findings[0] as (typeof view.findings)[number]
    const short = await send(`${BASE}/${run.id}/acceptances`, 'POST', paola, {
      code: finding.code,
      refKey: finding.refKey,
      reason: 'ok',
    })
    expect(short.status).toBe(400)
    expect(await short.json()).toEqual({ error: 'invalid' })
    const accepted = await send(`${BASE}/${run.id}/acceptances`, 'POST', paola, {
      code: finding.code,
      refKey: finding.refKey,
      reason: 'Il DWSI non è collegato a questo progetto.',
    })
    expect(await accepted.json()).toMatchObject({
      findings: [{ status: 'accepted' }],
      approvable: true,
      summary: { open: 0, accepted: 1 },
    })

    const change = await send(`${BASE}/${run.id}/changes`, 'POST', paola, {
      slots: ['context'],
      request: 'Più breve.',
    })
    expect(change.status).toBe(202)
    expect((await send(`${BASE}/${run.id}/approval`, 'POST', paola)).status).toBe(202)
    const jobs = [...(deps.queue as never as { jobs: Map<string, { name: string }> }).jobs.values()]
    expect(jobs.map((job) => job.name)).toEqual([
      'deliverable.run',
      'deliverable.revise',
      'deliverable.render',
    ])
  })

  it('downloads a file of an approved run and hides runs from who is not a member', async () => {
    const { paola, send, ready, runs, deps, signIn } = await project()
    const run = await ready()
    const bytes = new TextEncoder().encode('# Mail al cliente')
    const projectId = (runs.rows.get(run.id)?.run.projectId ?? '') as string
    const { key, sha256 } = await (deps.blobs as InMemoryBlobs).put(projectId, bytes)
    await runs.completeApproval(run.id, [
      {
        audience: 'client',
        format: 'md',
        fileName: 'mail-cliente-1.0.0-cliente.md',
        sha256,
        sizeBytes: bytes.length,
        blobKey: key,
      },
    ])
    const view = (await (await send(`${BASE}/${run.id}`, 'GET', paola)).json()) as {
      files: Array<{ id: string }>
    }
    const file = await send(`${BASE}/${run.id}/files/${view.files[0]?.id}`, 'GET', paola)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('text/markdown')
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="mail-cliente-1.0.0-cliente.md"',
    )
    expect(await file.text()).toBe('# Mail al cliente')

    const marco = await signIn('marco@example.test', 'Marco Membro')
    expect((await send(`${BASE}/${run.id}`, 'GET', marco)).status).toBe(404)
    await send('/api/projects/aurora/members', 'POST', paola, { email: 'marco@example.test' })
    expect((await send(`${BASE}/${run.id}`, 'GET', marco)).status).toBe(200)
    expect((await send(`${BASE}/${run.id}/approval`, 'POST', marco)).status).toBe(403)
  })
})
