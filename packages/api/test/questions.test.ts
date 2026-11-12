import type { InMemoryJobQueue, InMemoryQuestions } from '@octobrief/application/testing'
import { describe, expect, it } from 'vitest'
import { setup } from './support.ts'

async function project() {
  const context = setup()
  const paola = await context.signIn()
  await context.send('/api/projects', 'POST', paola, { name: 'Borea' })
  const questions = context.deps.questions as InMemoryQuestions
  return { ...context, paola, questions }
}

const BASE = '/api/projects/borea/questions'

describe('questions API', () => {
  it('asks, lists, shows and removes a question', async () => {
    const { paola, send, questions, deps } = await project()
    const asked = await send(BASE, 'POST', paola, { text: ' Qual è il budget? ' })
    expect(asked.status).toBe(201)
    const question = (await asked.json()) as { id: string; phase: string; text: string }
    expect(question).toMatchObject({ phase: 'queued', text: 'Qual è il budget?' })
    const jobs = [...(deps.queue as InMemoryJobQueue).jobs.values()]
    expect(jobs.at(-1)).toMatchObject({
      name: 'question.answer',
      data: { questionId: question.id },
    })

    await questions.saveAnswer(question.id, {
      lang: 'it',
      segments: [],
      contradictions: [],
      absences: [],
      checks: { total: 1, anomalies: 0, list: [] },
    })
    const list = (await (await send(BASE, 'GET', paola)).json()) as { questions: unknown[] }
    expect(list.questions).toMatchObject([{ id: question.id, phase: 'done' }])
    expect(JSON.stringify(list)).not.toContain('"answer"')
    const shown = await send(`${BASE}/${question.id}`, 'GET', paola)
    expect(await shown.json()).toMatchObject({
      id: question.id,
      phase: 'done',
      answer: { lang: 'it', checks: { total: 1, anomalies: 0 } },
      answeredAt: expect.any(String),
    })
    expect((await send(`${BASE}/${question.id}`, 'DELETE', paola)).status).toBe(204)
    expect((await send(`${BASE}/${question.id}`, 'GET', paola)).status).toBe(404)
  })

  it('refuses an empty question and hides the questions of others', async () => {
    const { paola, send, signIn } = await project()
    expect((await send(BASE, 'POST', paola, { text: '  ' })).status).toBe(400)
    const asked = await send(BASE, 'POST', paola, { text: 'Budget?' })
    const { id } = (await asked.json()) as { id: string }
    const marco = await signIn('marco@example.test', 'Marco Membro')
    expect((await send(BASE, 'GET', marco)).status).toBe(404)
    await send('/api/projects/borea/members', 'POST', paola, { email: 'marco@example.test' })
    expect(await (await send(BASE, 'GET', marco)).json()).toEqual({ questions: [] })
    expect((await send(`${BASE}/${id}`, 'GET', marco)).status).toBe(404)
    expect((await send(`${BASE}/${id}/events`, 'GET', marco)).status).toBe(404)
  })

  it('streams the phases of a question as events until it settles', async () => {
    const { paola, send, questions } = await project()
    const asked = await send(BASE, 'POST', paola, { text: 'Budget?' })
    const { id } = (await asked.json()) as { id: string }
    const response = await send(`${BASE}/${id}/events`, 'GET', paola)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    setTimeout(() => void questions.setPhase(id, 'reading'), 50)
    setTimeout(() => void questions.saveFailure(id, 'model_busy'), 600)
    const text = await response.text()
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)))
    expect(events[0]).toEqual({ phase: 'queued', error: null })
    expect(events.at(-1)).toEqual({ phase: 'failed', error: 'model_busy' })
    expect(text).toContain('event: phase')
  })
})
