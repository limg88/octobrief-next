import { describe, expect, it } from 'vitest'
import {
  checkPrerequisites,
  factKeyMatches,
  type PrerequisiteSource,
  type PrerequisiteView,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'

const NOW = new Date('2026-11-06T09:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

const dwsi = (over: Partial<PrerequisiteSource> = {}): PrerequisiteSource => ({
  kind: 'netsuite_dwsi',
  label: 'Sistema amministrativo',
  lastSuccessAt: hoursAgo(2),
  dataAsOf: hoursAgo(3),
  pending: false,
  ...over,
})

const view = (over: Partial<PrerequisiteView> = {}): PrerequisiteView => ({
  thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
  evidenceKinds: [],
  sources: [dwsi()],
  facts: [],
  ...over,
})

/** No code, no identifier, no path: only words for the PM (a day is written gg/mm/aaaa). */
const inPmWords = (text: string) => {
  expect(text).not.toMatch(/[_{}]|netsuite|dwsi|sha256|\\|[a-z]\/[a-z]/i)
}

describe('prerequisites of a recipe', () => {
  it('is ready when the required sources have fresh data', () => {
    const r = checkPrerequisites(recipeOf(), view(), NOW, 'it')
    expect(r).toMatchObject({ status: 'ready', text: 'Pronta', reasons: [] })
  })

  it('lists every prerequisite, required and useful, as present or missing with its reason', () => {
    const raw = sampleRecipe()
    raw.prerequisites = [
      { kind: 'evidence', documentKinds: ['contract'], level: 'required' },
      { kind: 'evidence', documentKinds: ['transcript'], level: 'if_present' },
    ]
    const r = checkPrerequisites(recipeOf(raw), view({ evidenceKinds: ['contract'] }), NOW, 'it')
    expect(r.status).toBe('ready')
    expect(r.checks).toEqual([
      {
        level: 'required',
        label: 'un documento fra questi: contratti',
        present: true,
        reason: null,
      },
      {
        level: 'if_present',
        label: 'un documento fra questi: trascrizioni',
        present: false,
        reason: 'carica un documento fra questi: trascrizioni',
      },
    ])
  })

  it('reports a missing prerequisite in PM words without calling the model', () => {
    // Pure: nothing but the recipe, what the project holds and the time. No runner exists here.
    const r = checkPrerequisites(recipeOf(), view({ sources: [] }), NOW, 'it')
    expect(r.status).toBe('needs_step')
    expect(r.text).toBe('Serve un passo: collega una fonte fra queste: sistema amministrativo.')
    inPmWords(r.text)
  })

  it('asks for a document of the kinds required, and ignores the optional ones', () => {
    const raw = sampleRecipe()
    raw.prerequisites = [
      { kind: 'evidence', documentKinds: ['contract', 'status_report'], level: 'required' },
      { kind: 'evidence', documentKinds: ['transcript'], level: 'if_present' },
    ]
    const missing = checkPrerequisites(recipeOf(raw), view(), NOW, 'it')
    expect(missing.text).toBe(
      'Serve un passo: carica un documento fra questi: contratti, stato avanzamento.',
    )
    const held = checkPrerequisites(recipeOf(raw), view({ evidenceKinds: ['contract'] }), NOW, 'it')
    expect(held.status).toBe('ready')
  })

  it('asks for a fact of the kind and key required', () => {
    const raw = sampleRecipe()
    raw.prerequisites = [
      { kind: 'fact', factKind: 'milestone', key: 'collaudo', level: 'required' },
      { kind: 'fact', factKind: 'risk', level: 'required' },
    ]
    const r = checkPrerequisites(recipeOf(raw), view(), NOW, 'it')
    expect(r.reasons).toEqual([
      'aggiungi alla conoscenza «collaudo»',
      'aggiungi alla conoscenza un dato di tipo «rischi»',
    ])
    const held = checkPrerequisites(
      recipeOf(raw),
      view({
        facts: [
          { kind: 'milestone', key: 'milestone:collaudo:finale' },
          { kind: 'risk', key: 'risk:fornitore' },
        ],
      }),
      NOW,
      'it',
    )
    expect(held.status).toBe('ready')
    expect(factKeyMatches('milestone', 'collaudo', 'milestone:collaudo')).toBe(true)
    expect(factKeyMatches('milestone', 'collaudo', 'milestone:collaudo-bis')).toBe(false)
  })

  it('says system data is missing when it is older than the stop threshold of the recipe', () => {
    // The sample recipe stops the warehouse data at 48 hours, stricter than the project's 72.
    const stale = checkPrerequisites(
      recipeOf(),
      view({ sources: [dwsi({ dataAsOf: hoursAgo(50) })] }),
      NOW,
      'it',
    )
    expect(stale.status).toBe('missing_system_data')
    expect(stale.text).toBe(
      'Mancano dati di sistema aggiornati: Sistema amministrativo è aggiornato al 04/11/2026.',
    )
    inPmWords(stale.text)
    // Between the thresholds the run goes on: the warning belongs to the document.
    const warned = checkPrerequisites(
      recipeOf(),
      view({ sources: [dwsi({ dataAsOf: hoursAgo(30) })] }),
      NOW,
      'it',
    )
    expect(warned.status).toBe('ready')
  })

  it('says why data cannot be used: never synced, or undated by the warehouse', () => {
    const never = checkPrerequisites(
      recipeOf(),
      view({ sources: [dwsi({ lastSuccessAt: null, dataAsOf: null })] }),
      NOW,
      'it',
    )
    expect(never.reasons).toEqual(['Sistema amministrativo non ha ancora finito un aggiornamento'])
    const undated = checkPrerequisites(
      recipeOf(),
      view({ sources: [dwsi({ dataAsOf: null })] }),
      NOW,
      'it',
    )
    expect(undated.reasons).toEqual([
      'Sistema amministrativo non dice a quando risalgono i suoi dati',
    ])
    // Every source the recipe reads counts: one fresh source does not hide one never synced.
    const one = checkPrerequisites(
      recipeOf(),
      view({
        sources: [dwsi({ label: 'Secondo', lastSuccessAt: null, dataAsOf: null }), dwsi()],
      }),
      NOW,
      'it',
    )
    expect(one.status).toBe('missing_system_data')
    expect(one.text).toBe(
      'Mancano dati di sistema aggiornati: Secondo non ha ancora finito un aggiornamento.',
    )
  })

  it('dates a tracker by its last completed sync', () => {
    const raw = sampleRecipe()
    raw.prerequisites = [{ kind: 'source', sourceKinds: ['ado', 'jira'], level: 'required' }]
    const tracker: PrerequisiteSource = {
      kind: 'ado',
      label: 'Backlog',
      lastSuccessAt: hoursAgo(80),
      dataAsOf: null,
      pending: false,
    }
    const r = checkPrerequisites(recipeOf(raw), view({ sources: [tracker] }), NOW, 'it')
    expect(r.status).toBe('missing_system_data')
    // A document source only needs to be there.
    raw.prerequisites = [{ kind: 'source', sourceKinds: ['sharepoint'], level: 'required' }]
    const docs = checkPrerequisites(
      recipeOf(raw),
      view({ sources: [{ ...tracker, kind: 'sharepoint', lastSuccessAt: null }] }),
      NOW,
      'it',
    )
    expect(docs.status).toBe('ready')
  })

  it('puts a step to take before data that is missing, five reasons at most', () => {
    const raw = sampleRecipe()
    raw.prerequisites = [
      ...raw.prerequisites,
      ...['decision', 'risk', 'action', 'status', 'milestone', 'note'].map((factKind) => ({
        kind: 'fact',
        factKind,
        level: 'required',
      })),
    ]
    const r = checkPrerequisites(
      recipeOf(raw),
      view({ sources: [dwsi({ dataAsOf: hoursAgo(100) })] }),
      NOW,
      'it',
    )
    expect(r.status).toBe('needs_step')
    expect(r.reasons).toHaveLength(5)
  })
})
