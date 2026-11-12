import { describe, expect, it } from 'vitest'
import {
  createReadLog,
  DEFAULT_FRESHNESS,
  DomainError,
  type EvidenceId,
  type FactId,
  type Locator,
  rehydrateVerifiedAnswer,
  type SourceRegistry,
  type VerifiedAnswer,
  verifyAnswer,
} from '../src/recipe/index.ts'

const NOW = new Date('2026-11-05T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
const DOC = '0b9c3d43-5a0e-4c39-9a51-6f3b9b0c1a11' as EvidenceId
const OLD = '1c9c3d43-5a0e-4c39-9a51-6f3b9b0c1a12' as EvidenceId
const FACT = '2d9c3d43-5a0e-4c39-9a51-6f3b9b0c1a13' as FactId
const PAGE: Locator = { kind: 'page', page: 1 }

// System data, judged by the thresholds (documents: freshness-policy.test.ts).
const SYSTEM = { freshnessPolicy: 'system', superseded: false } as const

const registry: SourceRegistry = {
  tracker: () => null,
  evidence: (id) =>
    id === DOC
      ? { title: 'SAL ottobre', sourceDate: hoursAgo(30), dateSource: 'file_name', ...SYSTEM }
      : id === OLD
        ? { title: 'SAL agosto', sourceDate: hoursAgo(24 * 60), dateSource: 'metadata', ...SYSTEM }
        : null,
  fact: (id) =>
    id === FACT
      ? {
          title: 'Verbale',
          sourceDate: hoursAgo(2),
          dateSource: 'pm',
          pmAsserted: true,
          contested: false,
          ...SYSTEM,
        }
      : null,
}

/** A verified answer with every part: segments of each kind, a contradiction and an absence. */
function sample(): VerifiedAnswer {
  const log = createReadLog()
  log.recordEvidence(DOC, [{ locator: PAGE, numbers: ['1200', '62'] }])
  log.recordEvidence(OLD, [{ locator: PAGE, numbers: ['900'] }])
  log.recordFact(FACT, [])
  return verifyAnswer(
    {
      lang: 'it',
      segments: [
        {
          text: 'Il budget è di 1.200 €',
          nature: 'fact',
          sources: [{ evidenceId: DOC, locator: PAGE }],
        },
        {
          text: 'Il budget era di 900 €',
          nature: 'fact',
          sources: [{ evidenceId: OLD, locator: PAGE }],
        },
        { text: 'Il collaudo è a 5 giorni', nature: 'fact', sources: [] },
        { text: 'Conviene sentire il fornitore', nature: 'suggestion', sources: [] },
        { text: 'La fase è stata chiusa', nature: 'inference', sources: [{ factId: FACT }] },
      ],
      contradictions: [
        {
          subject: 'Budget',
          reason: 'Le fonti divergono',
          sides: [
            { value: '1.200 €', source: { evidenceId: DOC, locator: PAGE } },
            { value: '900 €', source: { evidenceId: OLD, locator: PAGE } },
          ],
        },
      ],
      absences: [
        { question: 'Chi approva il collaudo?', proposal: 'Chiedere al comitato' },
        { question: 'Serve il 15% in più?', proposal: 'Verificare' },
      ],
    },
    {
      lang: 'it',
      read: log.snapshot(),
      registry,
      thresholds: DEFAULT_FRESHNESS,
      now: NOW,
      knownNames: [],
    },
  )
}

/** What storage gives back: the JSON of the answer, dates as strings. */
const stored = (answer: VerifiedAnswer = sample()): Record<string, unknown> =>
  JSON.parse(JSON.stringify(answer))

const expectInvalid = (value: unknown) => {
  let error: unknown
  try {
    rehydrateVerifiedAnswer(value)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(DomainError)
  expect((error as DomainError).code).toBe('stored_value_invalid')
}

// biome-ignore lint/suspicious/noExplicitAny: stored JSON altered by path in the tests
type Json = Record<string, any>

describe('rehydrateVerifiedAnswer', () => {
  it('gives back the answer as it was verified, dates included', () => {
    const answer = sample()
    expect(rehydrateVerifiedAnswer(stored(answer))).toEqual(answer)
    const first = rehydrateVerifiedAnswer(stored(answer)).segments[0]?.sources[0]
    expect(first?.sourceDate).toBeInstanceOf(Date)
  })

  it('covers every part of the sample (the round trip is meaningful)', () => {
    const answer = sample()
    expect(answer.segments.map((s) => s.suspendedReason)).toEqual([
      null,
      'stale_data',
      'without_source',
      null,
      null,
    ])
    expect(answer.contradictions[0]?.sides.map((s) => s.suspendedReason)).toEqual([
      null,
      'stale_data',
    ])
    expect(answer.absences.map((a) => a.suppressed)).toEqual([false, true])
  })

  it('gives back system data of unknown age, cited as evidence', () => {
    const undated: SourceRegistry = {
      ...registry,
      evidence: (id) =>
        id === DOC
          ? { title: 'Estrazione DWSI', sourceDate: null, dateSource: 'acquisition', ...SYSTEM }
          : registry.evidence(id),
    }
    const log = createReadLog()
    log.recordEvidence(DOC, [{ locator: PAGE, numbers: ['1200'] }])
    const answer = verifyAnswer(
      {
        lang: 'it',
        segments: [
          { text: 'Ore 1.200', nature: 'fact', sources: [{ evidenceId: DOC, locator: PAGE }] },
        ],
        contradictions: [],
        absences: [],
      },
      {
        lang: 'it',
        read: log.snapshot(),
        registry: undated,
        thresholds: DEFAULT_FRESHNESS,
        now: NOW,
        knownNames: [],
      },
    )
    expect(answer.segments[0]?.suspendedReason).toBe('unknown_freshness')
    expect(rehydrateVerifiedAnswer(JSON.parse(JSON.stringify(answer)))).toEqual(answer)
    // A document is always dated.
    const doc = JSON.parse(JSON.stringify(answer)) as Json
    doc.segments[0].sources[0].freshnessPolicy = 'document'
    expectInvalid(doc)
  })

  it('refuses what is not an answer', () => {
    for (const value of [null, 'x', 1, [], {}]) expectInvalid(value)
  })

  it('refuses an unknown language, nature or reason', () => {
    expectInvalid({ ...stored(), lang: 'en' })
    const s = stored() as Json
    s.segments[0].nature = 'opinion'
    expectInvalid(s)
    const r = stored() as Json
    r.segments[1].suspendedReason = 'because'
    expectInvalid(r)
  })

  it('refuses a suspended segment that still carries its text', () => {
    const s = stored() as Json
    s.segments[2].text = s.segments[2].originalText
    expectInvalid(s)
  })

  it('refuses a shown segment without text, and a segment without source not suspended', () => {
    const s = stored() as Json
    s.segments[0].text = null
    expectInvalid(s)
    const w = stored() as Json
    w.segments[2].suspendedReason = null
    w.segments[2].text = w.segments[2].originalText
    expectInvalid(w)
  })

  it('refuses a verified source without title or date, and a malformed date', () => {
    const t = stored() as Json
    t.segments[0].sources[0].title = null
    expectInvalid(t)
    const d = stored() as Json
    d.segments[0].sources[0].sourceDate = 'yesterday'
    expectInvalid(d)
  })

  it('refuses a verified source with a plausible date but no freshness', () => {
    const s = stored() as Json
    s.segments[0].sources[0].freshness = null
    expectInvalid(s)
  })

  it('refuses a malformed citation or freshness', () => {
    const c = stored() as Json
    c.segments[0].sources[0].ref = { evidenceId: DOC, locator: { kind: 'page', page: 0 } }
    expectInvalid(c)
    const both = stored() as Json
    both.segments[0].sources[0].ref = { evidenceId: DOC, locator: PAGE, factId: FACT }
    expectInvalid(both)
    const f = stored() as Json
    f.segments[0].sources[0].freshness = { level: 'fresh', ageHours: -1 }
    expectInvalid(f)
  })

  it('refuses a contradiction or an absence that shows a suppressed text', () => {
    const c = stored() as Json
    c.contradictions[0].sides[1].value = '900 €'
    expectInvalid(c)
    const a = stored() as Json
    a.absences[1].question = 'Serve il 15% in più?'
    expectInvalid(a)
    const s = stored() as Json
    s.contradictions[0].suppressed = true
    expectInvalid(s)
  })

  it('refuses counts of checks that do not match the anomalies listed', () => {
    const s = stored() as Json
    s.checks.anomalies += 1
    expectInvalid(s)
    const c = stored() as Json
    c.checks.list[0].code = 'made_up'
    expectInvalid(c)
    const z = stored() as Json
    z.checks.total = 0
    expectInvalid(z)
  })

  it('drops fields that are not part of the answer', () => {
    const s = stored() as Json
    s.extra = 'x'
    s.segments[0].html = '<b>x</b>'
    const back = rehydrateVerifiedAnswer(s) as unknown as Json
    expect(back.extra).toBeUndefined()
    expect(back.segments[0].html).toBeUndefined()
  })
})
