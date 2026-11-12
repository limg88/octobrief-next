import { describe, expect, it } from 'vitest'
import {
  type AnswerSourceRef,
  createReadLog,
  DEFAULT_FRESHNESS,
  DomainError,
  modelAnswerSchema,
  parseModelAnswer,
  type RegisteredTracker,
  rehydrateVerifiedAnswer,
  type SourceId,
  type SourceRegistry,
  type TrackerLocator,
  type VerifyContext,
  verifyAnswer,
  workItemOf,
  workItemReads,
  workItemRow,
} from '../src/index.ts'

const NOW = new Date('2026-11-05T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

const FRESH = 'a0000000-0000-4000-8000-000000000001' as SourceId
const OLDISH = 'a0000000-0000-4000-8000-000000000002' as SourceId
const STALE = 'a0000000-0000-4000-8000-000000000003' as SourceId
const NEVER = 'a0000000-0000-4000-8000-000000000004' as SourceId
const UNKNOWN = 'a0000000-0000-4000-8000-000000000005' as SourceId

const tracker = (title: string, sourceDate: Date | null): RegisteredTracker => ({
  title,
  sourceDate,
  dateSource: 'system',
  freshnessPolicy: 'system',
  superseded: false,
})

const trackers: Record<string, RegisteredTracker> = {
  [FRESH]: tracker('Azure DevOps Apollo', hoursAgo(2)),
  [OLDISH]: tracker('Jira Apollo', hoursAgo(30)),
  [STALE]: tracker('Jira vecchio', hoursAgo(100)),
  [NEVER]: tracker('Azure DevOps nuovo', null),
}

const registry: SourceRegistry = {
  evidence: () => null,
  fact: () => null,
  tracker: (id) => trackers[id] ?? null,
}

const item = workItemOf({
  sourceId: FRESH,
  kind: 'ado',
  externalId: '42',
  url: null,
  fields: {
    title: 'Login con SSO',
    state: 'Active',
    iterationPath: 'Apollo\\Sprint 12',
    storyPoints: 5,
    assignedTo: 'Mario Rossi',
    changedAt: '2026-11-03T10:00:00.000Z',
  },
})

const counts: TrackerLocator = { kind: 'work_item_counts' }
const wi = (id: string, field?: 'state' | 'story_points'): TrackerLocator =>
  field ? { kind: 'work_item', id, field } : { kind: 'work_item', id }

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  const log = createReadLog()
  log.recordTracker(FRESH, workItemReads('42', workItemRow(item), 'it'))
  log.recordTracker(FRESH, [{ locator: counts, numbers: ['12', '34'] }])
  log.recordTracker(OLDISH, [{ locator: counts, numbers: ['7'] }])
  log.recordTracker(STALE, [{ locator: counts, numbers: ['9'] }])
  log.recordTracker(NEVER, [{ locator: counts, numbers: ['4'] }])
  log.recordTracker(UNKNOWN, [{ locator: counts, numbers: ['4'] }])
  return {
    lang: 'it',
    read: log.snapshot(),
    registry,
    thresholds: DEFAULT_FRESHNESS,
    now: NOW,
    knownNames: ['Mario Rossi'],
    ...overrides,
  }
}

const cite = (sourceId: SourceId, locator: TrackerLocator): AnswerSourceRef => ({
  sourceId,
  locator,
})

const one = (text: string, sources: AnswerSourceRef[], nature: 'fact' | 'inference' = 'fact') =>
  verifyAnswer(
    { lang: 'it', segments: [{ text, nature, sources }], contradictions: [], absences: [] },
    context(),
  )

describe('a tracker citation in the contract', () => {
  it('is accepted with a work item, one of its fields or the counts', () => {
    const parsed = parseModelAnswer({
      lang: 'it',
      segments: [
        {
          text: 'Il work item 42 è attivo',
          nature: 'fact',
          sources: [
            { sourceId: FRESH, locator: { kind: 'work_item', id: '42', field: 'state', x: 1 } },
            { sourceId: FRESH, locator: { kind: 'work_item_counts' } },
          ],
        },
      ],
      contradictions: [],
      absences: [],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.segments[0]?.sources).toEqual([
      { sourceId: FRESH, locator: { kind: 'work_item', id: '42', field: 'state' } },
      { sourceId: FRESH, locator: { kind: 'work_item_counts' } },
    ])
  })

  it('is refused with a document locator, an unknown field or mixed with another form', () => {
    const withSource = (source: unknown) =>
      parseModelAnswer({
        lang: 'it',
        segments: [{ text: 'x', nature: 'fact', sources: [source] }],
        contradictions: [],
        absences: [],
      })
    expect(withSource({ sourceId: FRESH, locator: { kind: 'page', page: 1 } })).toEqual({
      error: { path: 'segments.0.sources.0.locator', problem: 'invalid' },
    })
    expect(
      withSource({ sourceId: FRESH, locator: { kind: 'work_item', id: '1', field: 'cost' } }),
    ).toEqual({ error: { path: 'segments.0.sources.0.locator', problem: 'invalid' } })
    expect(withSource({ sourceId: FRESH, factId: 'f', locator: counts })).toEqual({
      error: { path: 'segments.0.sources.0', problem: 'invalid' },
    })
    expect(withSource({ evidenceId: 'e', sourceId: FRESH, locator: counts })).toEqual({
      error: { path: 'segments.0.sources.0', problem: 'invalid' },
    })
    expect(withSource({ sourceId: ' ', locator: counts })).toEqual({
      error: { path: 'segments.0.sources.0.sourceId', problem: 'invalid' },
    })
  })

  it('is described to the model as a third closed form of source', () => {
    const forms = modelAnswerSchema.properties.segments.items.properties.sources.items.anyOf
    expect(forms.map((f) => Object.keys(f.properties))).toEqual([
      ['evidenceId', 'locator'],
      ['factId'],
      ['sourceId', 'locator'],
    ])
  })
})

describe('verifying a tracker citation', () => {
  it('verifies a number the tool showed for the work item or its field', () => {
    const ok = one('Il work item 42 vale 5 story point', [cite(FRESH, wi('42', 'story_points'))])
    expect(ok.segments[0]?.sources[0]).toMatchObject({
      verified: true,
      title: 'Azure DevOps Apollo',
      dateSource: 'system',
      freshnessPolicy: 'system',
      freshness: { level: 'fresh' },
    })
    expect(ok.segments[0]?.text).not.toBeNull()
    expect(one('Il 42 è nello Sprint 12', [cite(FRESH, wi('42'))]).segments[0]?.text).not.toBeNull()
  })

  it('refuses a number the field did not show, even if another field of the item did', () => {
    const wrong = one('Il work item 42 vale 12 story point', [
      cite(FRESH, wi('42', 'story_points')),
    ])
    expect(wrong.segments[0]?.sources[0]?.reason).toBe('numbers_not_in_source')
    expect(wrong.segments[0]?.suspendedReason).toBe('without_source')
  })

  it('verifies a count only against the counts the tool showed for that source', () => {
    expect(one('Ci sono 12 work item attivi', [cite(FRESH, counts)]).segments[0]?.text).toBe(
      'Ci sono 12 work item attivi',
    )
    const other = one('Ci sono 7 work item attivi', [cite(FRESH, counts)])
    expect(other.segments[0]?.sources[0]?.reason).toBe('numbers_not_in_source')
  })

  it('refuses a work item that was not shown and a source that is not a tracker', () => {
    const notShown = one('Il 43 è attivo', [cite(FRESH, wi('43'))])
    expect(notShown.segments[0]?.sources[0]?.reason).toBe('not_read')
    expect(notShown.segments[0]?.suspendedReason).toBe('without_source')
    const unknown = one('Ci sono 4 work item', [cite(UNKNOWN, counts)])
    expect(unknown.segments[0]?.sources[0]).toMatchObject({
      verified: false,
      reason: 'unknown_source',
      title: null,
    })
    const bad = one('Ci sono 12 work item', [
      { sourceId: FRESH, locator: { kind: 'work_item', id: '' } as TrackerLocator },
    ])
    expect(bad.segments[0]?.sources[0]?.reason).toBe('not_read')
  })

  it('judges the age by the health of the connector: warning, then suspended past the stop', () => {
    const warn = one('Ci sono 7 work item', [cite(OLDISH, counts)])
    expect(warn.segments[0]).toMatchObject({ freshness: 'warning', warning: 'to_recheck' })
    expect(warn.segments[0]?.text).not.toBeNull()
    const stale = one('Ci sono 9 work item', [cite(STALE, counts)])
    expect(stale.segments[0]).toMatchObject({ text: null, suspendedReason: 'stale_data' })
    expect(stale.checks.list).toContainEqual({ code: 'stale_data', index: 0 })
  })

  it('suspends the data of a tracker whose age is unknown, as an anomaly', () => {
    const never = one('Ci sono 4 work item', [cite(NEVER, counts)])
    expect(never.segments[0]?.sources[0]).toMatchObject({
      verified: true,
      sourceDate: null,
      freshness: null,
    })
    expect(never.segments[0]).toMatchObject({
      text: null,
      freshness: 'unknown',
      suspendedReason: 'unknown_freshness',
    })
    expect(never.checks.list).toEqual([{ code: 'unknown_source_freshness', index: 0 }])
    // A qualitative sentence stays, with the anomaly.
    const qualitative = one('Il tracker è collegato', [cite(NEVER, counts)], 'inference')
    expect(qualitative.segments[0]?.text).toBe('Il tracker è collegato')
  })

  it('needs a verified source for a sentence naming an assignee', () => {
    const named = one('Lo segue Mario Rossi', [], 'inference')
    expect(named.segments[0]?.suspendedReason).toBe('without_source')
    const cited = one('Lo segue Mario Rossi', [cite(FRESH, wi('42'))], 'inference')
    expect(cited.segments[0]?.text).toBe('Lo segue Mario Rossi')
  })

  it('tells two work items of one tracker apart in a contradiction, not two fields of one', () => {
    const verify = (a: TrackerLocator, b: TrackerLocator) =>
      verifyAnswer(
        {
          lang: 'it',
          segments: [],
          contradictions: [
            {
              subject: 'Stato',
              reason: 'Diverge',
              sides: [
                { value: 'attivo', source: cite(FRESH, a) },
                { value: 'chiuso', source: cite(FRESH, b) },
              ],
            },
          ],
          absences: [],
        },
        context(),
      )
    expect(verify(wi('42'), counts).contradictions[0]?.sameDocument).toBe(false)
    expect(verify(wi('42', 'state'), wi('42')).contradictions[0]?.sameDocument).toBe(true)
  })

  it('marks a contradiction side of unknown age', () => {
    const answer = verifyAnswer(
      {
        lang: 'it',
        segments: [],
        contradictions: [
          {
            subject: 'Volume',
            reason: 'Diverge',
            sides: [
              { value: '4 work item', source: cite(NEVER, counts) },
              { value: '12 work item', source: cite(FRESH, counts) },
            ],
          },
        ],
        absences: [],
      },
      context(),
    )
    expect(answer.contradictions[0]?.sides[0]?.suspendedReason).toBe('unknown_freshness')
    expect(answer.checks.list).toContainEqual({
      code: 'unknown_source_freshness',
      index: 0,
      side: 0,
    })
  })
})

describe('a stored answer with tracker citations', () => {
  it('reads back as it was verified, the unknown age included', () => {
    const verified = verifyAnswer(
      {
        lang: 'it',
        segments: [
          { text: 'Ci sono 12 work item', nature: 'fact', sources: [cite(FRESH, counts)] },
          { text: 'Il 42 è attivo', nature: 'fact', sources: [cite(FRESH, wi('42', 'state'))] },
          { text: 'Ci sono 4 work item', nature: 'fact', sources: [cite(NEVER, counts)] },
        ],
        contradictions: [],
        absences: [],
      },
      context(),
    )
    expect(rehydrateVerifiedAnswer(JSON.parse(JSON.stringify(verified)))).toEqual(verified)
  })

  it('refuses a document or a fact of unknown date, and a tracker locator that is not one', () => {
    const verified = verifyAnswer(
      {
        lang: 'it',
        segments: [{ text: 'Ci sono 4 work item', nature: 'fact', sources: [cite(NEVER, counts)] }],
        contradictions: [],
        absences: [],
      },
      context(),
    )
    const stored = JSON.parse(JSON.stringify(verified))
    const asDocument = structuredClone(stored)
    asDocument.segments[0].sources[0].ref = {
      evidenceId: 'e0000000-0000-4000-8000-000000000001',
      locator: { kind: 'page', page: 1 },
    }
    asDocument.segments[0].sources[0].freshnessPolicy = 'document'
    expect(() => rehydrateVerifiedAnswer(asDocument)).toThrow(DomainError)
    const badLocator = structuredClone(stored)
    badLocator.segments[0].sources[0].ref.locator = { kind: 'work_item', id: '' }
    expect(() => rehydrateVerifiedAnswer(badLocator)).toThrow(DomainError)
    const judged = structuredClone(stored)
    judged.segments[0].sources[0].freshness = { level: 'fresh', ageHours: 1 }
    expect(() => rehydrateVerifiedAnswer(judged)).toThrow(DomainError)
  })
})
