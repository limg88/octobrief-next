import { describe, expect, it } from 'vitest'
import {
  type AnswerSourceRef,
  createReadLog,
  DEFAULT_FRESHNESS,
  DomainError,
  type EvidenceId,
  type FactId,
  type Locator,
  type ModelAnswer,
  type RegisteredFact,
  type RegisteredSource,
  type SourceRegistry,
  shownNumbersIn,
  type VerifyContext,
  verifyAnswer,
} from '../src/recipe/index.ts'

const NOW = new Date('2026-11-05T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

const FRESH_DOC = 'e-fresh' as EvidenceId
const OLDISH_DOC = 'e-oldish' as EvidenceId
const STALE_DOC = 'e-stale' as EvidenceId
const OTHER_DOC = 'e-other' as EvidenceId
const UNREAD_DOC = 'e-unread' as EvidenceId
const FUTURE_DOC = 'e-future' as EvidenceId
const UNDATED_DOC = 'e-undated' as EvidenceId
const FACT = 'f-budget' as FactId
const PM_FACT = 'f-pm' as FactId
const UNKNOWN_FACT = 'f-unknown' as FactId
const CONTESTED_FACT = 'f-contested' as FactId
const PLAN_THREE = 'e-plan-three' as EvidenceId
const PLAN_TWO = 'e-plan-two' as EvidenceId

const PAGE_1: Locator = { kind: 'page', page: 1 }
const PAGE_2: Locator = { kind: 'page', page: 2 }

// Every source here is system data: the thresholds judge it (documents: freshness-policy.test.ts).
const SYSTEM = { freshnessPolicy: 'system', superseded: false } as const

const evidences: Record<string, RegisteredSource> = {
  [FRESH_DOC]: {
    title: 'SAL ottobre',
    sourceDate: hoursAgo(2),
    dateSource: 'file_name',
    ...SYSTEM,
  },
  [OLDISH_DOC]: {
    title: 'Verbale riunione',
    sourceDate: hoursAgo(48),
    dateSource: 'metadata',
    ...SYSTEM,
  },
  [STALE_DOC]: {
    title: 'SAL settembre',
    sourceDate: hoursAgo(24 * 30),
    dateSource: 'file_name',
    ...SYSTEM,
  },
  [OTHER_DOC]: {
    title: 'Contratto',
    sourceDate: hoursAgo(5),
    dateSource: 'acquisition',
    ...SYSTEM,
  },
  [UNREAD_DOC]: { title: 'Mai letto', sourceDate: hoursAgo(1), dateSource: 'pm', ...SYSTEM },
  [FUTURE_DOC]: {
    title: 'Dal futuro',
    sourceDate: hoursAgo(-48),
    dateSource: 'metadata',
    ...SYSTEM,
  },
  // System data its system did not date: its age is not deduced.
  [UNDATED_DOC]: {
    title: 'Estrazione DWSI',
    sourceDate: null,
    dateSource: 'acquisition',
    ...SYSTEM,
  },
  [PLAN_THREE]: { title: 'Piano A', sourceDate: hoursAgo(1), dateSource: 'file_name', ...SYSTEM },
  [PLAN_TWO]: { title: 'Piano B', sourceDate: hoursAgo(1), dateSource: 'file_name', ...SYSTEM },
}

const facts: Record<string, RegisteredFact> = {
  [FACT]: {
    title: 'economics:budget',
    sourceDate: hoursAgo(3),
    dateSource: 'file_name',
    pmAsserted: false,
    contested: false,
    ...SYSTEM,
  },
  [PM_FACT]: {
    title: 'status:fase',
    sourceDate: hoursAgo(10),
    dateSource: 'metadata',
    pmAsserted: true,
    contested: false,
    ...SYSTEM,
  },
  [CONTESTED_FACT]: {
    title: 'status:semaforo',
    sourceDate: hoursAgo(4),
    dateSource: 'file_name',
    pmAsserted: false,
    contested: true,
    ...SYSTEM,
  },
}

const registry: SourceRegistry = {
  tracker: () => null,
  evidence: (id) => evidences[id] ?? null,
  fact: (id) => facts[id] ?? null,
}

/** The numbers each source showed to the model when it was read. */
function readLog() {
  const log = createReadLog()
  log.recordEvidence(FRESH_DOC, [{ locator: PAGE_1, numbers: ['1200', '1500', '30', '60'] }])
  log.recordEvidence(OLDISH_DOC, [{ locator: PAGE_1, numbers: ['1200'] }])
  log.recordEvidence(STALE_DOC, [{ locator: PAGE_1, numbers: ['80000', '1200'] }])
  log.recordEvidence(OTHER_DOC, [{ locator: PAGE_1, numbers: ['1200', '15'] }])
  log.recordEvidence(FUTURE_DOC, [{ locator: PAGE_1, numbers: ['1200'] }])
  log.recordEvidence(UNDATED_DOC, [{ locator: PAGE_1, numbers: ['1200'] }])
  log.recordFact(FACT, ['1200'])
  log.recordFact(PM_FACT, [])
  log.recordFact(UNKNOWN_FACT, ['60'])
  log.recordFact(CONTESTED_FACT, [])
  log.recordEvidence(PLAN_THREE, [
    { locator: PAGE_1, numbers: shownNumbersIn('Restano tre settimane', 'it') },
  ])
  log.recordEvidence(PLAN_TWO, [
    { locator: PAGE_1, numbers: shownNumbersIn('Restano due settimane', 'it') },
  ])
  return log
}

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    lang: 'it',
    read: readLog().snapshot(),
    registry,
    thresholds: DEFAULT_FRESHNESS,
    now: NOW,
    knownNames: ['Mario Rossi', 'Acme', 'Niccolò'],
    ...overrides,
  }
}

const cite = (evidenceId: EvidenceId, locator: Locator = PAGE_1): AnswerSourceRef => ({
  evidenceId,
  locator,
})

function answer(
  segments: ModelAnswer['segments'],
  rest: Partial<Omit<ModelAnswer, 'segments'>> = {},
): ModelAnswer {
  return { lang: 'it', segments, contradictions: [], absences: [], ...rest }
}

const segment = (
  text: string,
  sources: AnswerSourceRef[],
  nature: 'fact' | 'inference' | 'suggestion' = 'inference',
) => ({ text, nature, sources })

const side = (value: string, source: AnswerSourceRef) => ({ value, source })

const contradiction = (
  sides: Array<{ value: string; source: AnswerSourceRef }>,
  subject = 'Budget',
  reason = 'Le fonti divergono',
) => ({ subject, reason, sides })

describe('verifyAnswer: names of outsiders', () => {
  it('count a part of an outsider only written with a capital', () => {
    const out = verifyAnswer(
      answer([segment('Fantini conferma il piano', []), segment('il fantini è un dolce', [])]),
      context({ knownNames: [], capitalNames: ['Fantini'] }),
    )
    expect(out.segments.map((s) => s.mentionsKnownName)).toEqual([true, false])
  })

  it('count a capitalized part of an outsider with other accents or in capitals', () => {
    const out = verifyAnswer(
      answer([
        segment('Fantìni conferma il piano', []),
        segment('Lo dice FANTINI', []),
        segment('il fantìni è un dolce', []),
        segment('Fantiniani non è un nome', []),
      ]),
      context({ knownNames: [], capitalNames: ['Fantini'] }),
    )
    expect(out.segments.map((s) => s.mentionsKnownName)).toEqual([true, true, false, false])
  })

  it('look up the capitalized parts in time linear in the text and the names', () => {
    const names = Array.from({ length: 5_000 }, (_, i) => `Nome${i}x`)
    const text = 'Parola '.repeat(20_000)
    const started = performance.now()
    const out = verifyAnswer(
      answer([segment(text, [])]),
      context({ knownNames: [], capitalNames: names }),
    )
    expect(out.segments[0]?.mentionsKnownName).toBe(false)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})

describe('verifyAnswer: sources', () => {
  it('a citation to an evidence that was not read is not verified', () => {
    const out = verifyAnswer(
      answer([segment('Il budget è di 1.200 €', [cite(UNREAD_DOC)], 'fact')]),
      context(),
    )
    const [seg] = out.segments
    expect(seg?.sources[0]?.verified).toBe(false)
    expect(seg?.sources[0]?.reason).toBe('not_read')
    expect(seg?.withoutSource).toBe(true)
    expect(seg?.freshness).toBe('unknown')
    expect(out.checks.list).toContainEqual({ code: 'without_source', index: 0 })
  })

  it('a locator of a chunk that was not read is not verified', () => {
    const out = verifyAnswer(
      answer([segment('Avanzamento al 60%', [cite(FRESH_DOC, PAGE_2)])]),
      context(),
    )
    expect(out.segments[0]?.sources[0]?.verified).toBe(false)
    expect(out.segments[0]?.withoutSource).toBe(true)
  })

  it('a source the registry does not know is not verified, even if read', () => {
    const out = verifyAnswer(
      answer([segment('Avanzamento al 60%', [{ factId: UNKNOWN_FACT }])]),
      context(),
    )
    const source = out.segments[0]?.sources[0]
    expect(source?.verified).toBe(false)
    expect(source?.reason).toBe('unknown_source')
    expect(source?.title).toBeNull()
    expect(source?.sourceDate).toBeNull()
    expect(out.segments[0]?.withoutSource).toBe(true)
  })

  it('a citation to an evidence read at that locator is verified with the registered data', () => {
    const out = verifyAnswer(
      answer([segment('Il budget è di 1.200 €', [cite(FRESH_DOC)], 'fact')]),
      context(),
    )
    const source = out.segments[0]?.sources[0]
    expect(source).toMatchObject({
      verified: true,
      reason: null,
      title: 'SAL ottobre',
      sourceDate: hoursAgo(2),
      dateSource: 'file_name',
      pmAsserted: false,
      futureDate: false,
    })
    expect(source?.freshness?.level).toBe('fresh')
    expect(source?.freshness?.ageHours).toBeCloseTo(2)
    expect(out.segments[0]).toMatchObject({
      withoutSource: false,
      freshness: 'fresh',
      text: 'Il budget è di 1.200 €',
      suspendedReason: null,
    })
  })

  it('a citation to a fact that was read is verified', () => {
    const out = verifyAnswer(
      answer([segment('Budget approvato', [{ factId: FACT }], 'fact')]),
      context(),
    )
    expect(out.segments[0]?.sources[0]).toMatchObject({
      verified: true,
      title: 'economics:budget',
      sourceDate: hoursAgo(3),
      pmAsserted: false,
    })
  })

  it('a fact stated by the PM is a verified source dated by the PM', () => {
    const out = verifyAnswer(
      answer([segment('Fase di test', [{ factId: PM_FACT }], 'fact')]),
      context(),
    )
    expect(out.segments[0]?.sources[0]).toMatchObject({
      verified: true,
      pmAsserted: true,
      dateSource: 'pm',
      sourceDate: hoursAgo(10),
    })
    expect(out.segments[0]?.withoutSource).toBe(false)
  })

  it('a fact that was not read is not verified', () => {
    const log = createReadLog()
    log.recordEvidence(FRESH_DOC, [{ locator: PAGE_1, numbers: [] }])
    const out = verifyAnswer(
      answer([segment('Budget approvato', [{ factId: FACT }], 'fact')]),
      context({ read: log.snapshot() }),
    )
    expect(out.segments[0]?.sources[0]?.reason).toBe('not_read')
    expect(out.segments[0]?.withoutSource).toBe(true)
  })

  it('a model-provided date is replaced by the registered one', () => {
    const invented = {
      evidenceId: STALE_DOC,
      locator: PAGE_1,
      title: 'SAL di ieri',
      sourceDate: NOW.toISOString(),
      dateSource: 'pm',
      freshness: 'fresh',
    } as unknown as AnswerSourceRef
    const out = verifyAnswer(
      answer([
        {
          text: 'Lo stato è verde',
          nature: 'inference',
          sources: [invented],
          freshness: 'fresh',
        } as unknown as ModelAnswer['segments'][number],
      ]),
      context(),
    )
    const source = out.segments[0]?.sources[0]
    expect(source?.title).toBe('SAL settembre')
    expect(source?.sourceDate).toEqual(hoursAgo(24 * 30))
    expect(source?.dateSource).toBe('file_name')
    expect(source?.freshness?.level).toBe('stale')
    expect(source?.ref).toEqual({ evidenceId: STALE_DOC, locator: PAGE_1 })
    expect(out.segments[0]?.freshness).toBe('stale')
  })
})

describe('verifyAnswer: contested facts', () => {
  it('a segment citing a contested fact keeps its text but carries the warning', () => {
    const result = verifyAnswer(
      answer([
        segment('Il semaforo del progetto è verde', [{ factId: CONTESTED_FACT }], 'fact'),
        segment('Il budget è di 1.200 €', [{ factId: FACT }], 'fact'),
      ]),
      context(),
    )
    const [contested, plain] = result.segments
    expect(contested).toMatchObject({ text: 'Il semaforo del progetto è verde', contested: true })
    expect(contested?.sources[0]).toMatchObject({ verified: true, contested: true })
    expect(plain).toMatchObject({ contested: false })
    expect(plain?.sources[0]).toMatchObject({ contested: false })
    expect(result.checks.list).toContainEqual({ code: 'contested_source', index: 0 })
    expect(result.checks.list.filter((a) => a.code === 'contested_source')).toHaveLength(1)
  })

  it('a document is never contested by itself', () => {
    const result = verifyAnswer(
      answer([segment('Il budget è di 1.200 €', [cite(FRESH_DOC)], 'fact')]),
      context(),
    )
    expect(result.segments[0]).toMatchObject({ contested: false })
  })
})

describe('verifyAnswer: numbers must be in the cited text', () => {
  it('a number that no verified source showed makes the sources unverified', () => {
    const out = verifyAnswer(
      answer([segment('Il budget è di 9.999 €', [cite(FRESH_DOC), { factId: FACT }], 'fact')]),
      context(),
    )
    const [seg] = out.segments
    expect(seg?.sources.map((s) => [s.verified, s.reason])).toEqual([
      [false, 'numbers_not_in_source'],
      [false, 'numbers_not_in_source'],
    ])
    expect(seg?.withoutSource).toBe(true)
    expect(seg?.text).toBeNull()
    expect(seg?.suspendedReason).toBe('without_source')
  })

  it('the numbers may come from different verified sources together', () => {
    const out = verifyAnswer(
      answer([segment('Budget 1.200 € e penale 15 €', [cite(FRESH_DOC), cite(OTHER_DOC)], 'fact')]),
      context(),
    )
    expect(out.segments[0]?.sources.every((s) => s.verified)).toBe(true)
    expect(out.segments[0]?.withoutSource).toBe(false)
  })

  it('compares numbers in canonical form', () => {
    const out = verifyAnswer(
      answer([segment('Budget 1200,00 euro', [cite(FRESH_DOC)], 'fact')]),
      context(),
    )
    expect(out.segments[0]?.withoutSource).toBe(false)
  })

  it('a contradiction side whose value is not in its source is unverified', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction([side('1.200 €', cite(FRESH_DOC)), side('7.000 €', cite(OTHER_DOC))]),
        ],
      }),
      context(),
    )
    const sides = out.contradictions[0]?.sides
    expect(sides?.[1]?.source.reason).toBe('numbers_not_in_source')
    expect(sides?.[1]?.value).toBeNull()
    expect(sides?.[1]?.originalValue).toBe('7.000 €')
    expect(sides?.[1]?.suspendedReason).toBe('without_source')
    expect(out.checks.list).toContainEqual({
      code: 'contradiction_unverified_side',
      index: 0,
      side: 1,
    })
  })
})

describe('verifyAnswer: canonical text', () => {
  it('reads data and names hidden behind invisible characters', () => {
    const out = verifyAnswer(
      answer([
        segment('Ne parla Mario\u200b Rossi', []),
        segment('Il cliente AC\u00adME', []),
        segment('Consegna a nov\u200bembre', []),
        segment('Costo €\u200b5', []),
        segment('Budget 1\u200b200', [cite(FRESH_DOC)]),
      ]),
      context(),
    )
    expect(out.segments.map((s) => s.inScope)).toEqual([true, true, true, true, true])
    expect(out.segments[2]?.dataKinds).toContain('date')
    expect(out.segments[3]?.dataKinds).toContain('amount')
    expect(out.segments[4]).toMatchObject({ withoutSource: false, text: 'Budget 1200' })
  })
})

describe('verifyAnswer: scope', () => {
  it('a qualitative inference without sources is out of scope and not an anomaly', () => {
    const out = verifyAnswer(answer([segment('Il clima del team è buono', [])]), context())
    expect(out.segments[0]).toMatchObject({
      inScope: false,
      withoutSource: false,
      freshness: 'unknown',
      warning: null,
      text: 'Il clima del team è buono',
    })
    expect(out.checks.anomalies).toBe(0)
  })

  it('an in-scope segment without a verified source has its text suspended', () => {
    const out = verifyAnswer(answer([segment('Il fornitore è in ritardo', [], 'fact')]), context())
    expect(out.segments[0]).toMatchObject({
      inScope: true,
      withoutSource: true,
      text: null,
      originalText: 'Il fornitore è in ritardo',
      suspendedReason: 'without_source',
      numbersSuspended: true,
    })
  })

  it('a number in a qualitative-looking sentence is still in scope', () => {
    const out = verifyAnswer(
      answer([segment('Secondo me il team lavora bene, circa 3 persone', [], 'suggestion')]),
      context(),
    )
    expect(out.segments[0]?.inScope).toBe(true)
    expect(out.segments[0]?.dataKinds).toContain('number')
    expect(out.segments[0]?.withoutSource).toBe(true)
  })

  it('amounts, percentages, dates and numbers in words bring a segment in scope', () => {
    const out = verifyAnswer(
      answer([
        segment('Costo di 12 k€', []),
        segment('Avanzamento al 45 %', []),
        segment('Consegna a novembre', []),
        segment('Restano tre settimane', []),
        segment('Ne abbiamo parlato ieri', []),
      ]),
      context(),
    )
    expect(out.segments.map((s) => s.inScope)).toEqual([true, true, true, true, true])
    expect(out.segments[0]?.dataKinds).toContain('amount')
    expect(out.segments[1]?.dataKinds).toContain('percentage')
    expect(out.segments[2]?.dataKinds).toEqual(['date'])
    expect(out.segments[3]?.dataKinds).toEqual(['number_word'])
    expect(out.segments[4]?.dataKinds).toEqual(['date'])
  })

  it('a known name brings a segment in scope: whole word, any case, any accent', () => {
    const out = verifyAnswer(
      answer([
        segment('Ne parla MARIO ROSSI', []),
        segment('Il cliente acme è soddisfatto', []),
        segment('Una acmeologia qualunque', []),
        segment('Lo dice Niccolo', []),
      ]),
      context(),
    )
    expect(out.segments.map((s) => s.inScope)).toEqual([true, true, false, true])
    expect(out.segments[0]?.mentionsKnownName).toBe(true)
  })

  it('ignores empty known names', () => {
    const out = verifyAnswer(
      answer([segment('Testo qualitativo', [])]),
      context({ knownNames: ['', '  ', '\u200b'] }),
    )
    expect(out.segments[0]?.inScope).toBe(false)
  })
})

describe('verifyAnswer: freshness', () => {
  it('stale quantitative segment has numbers suspended', () => {
    const out = verifyAnswer(
      answer([segment('Il budget speso è di 80.000 €', [cite(STALE_DOC)], 'fact')]),
      context(),
    )
    const [seg] = out.segments
    expect(seg?.freshness).toBe('stale')
    expect(seg?.numbersSuspended).toBe(true)
    expect(seg?.text).toBeNull()
    expect(seg?.suspendedReason).toBe('stale_data')
    expect(seg?.originalText).toBe('Il budget speso è di 80.000 €')
    expect(seg?.withoutSource).toBe(false)
    expect(out.checks.list).toContainEqual({ code: 'stale_data', index: 0 })
  })

  it('qualitative stale segment stays with warning', () => {
    const out = verifyAnswer(
      answer([segment('Il clima del team è buono', [cite(STALE_DOC)])]),
      context(),
    )
    const [seg] = out.segments
    expect(seg?.inScope).toBe(false)
    expect(seg?.numbersSuspended).toBe(false)
    expect(seg?.text).toBe('Il clima del team è buono')
    expect(seg?.suspendedReason).toBeNull()
    expect(seg?.warning).toBe('stale')
    expect(out.checks.anomalies).toBe(0)
  })

  it('a segment between the warning and the stop stays, to be rechecked', () => {
    const out = verifyAnswer(
      answer([segment('Il budget è di 1.200 €', [cite(OLDISH_DOC)], 'fact')]),
      context(),
    )
    expect(out.segments[0]).toMatchObject({
      freshness: 'warning',
      warning: 'to_recheck',
      numbersSuspended: false,
      text: 'Il budget è di 1.200 €',
    })
  })

  it('the worst verified source decides; unverified sources do not count', () => {
    const out = verifyAnswer(
      answer([
        segment('Budget di 1.200 €', [cite(FRESH_DOC), cite(OLDISH_DOC)], 'fact'),
        segment('Budget di 1.200 €', [cite(FRESH_DOC), cite(STALE_DOC, PAGE_2)], 'fact'),
      ]),
      context(),
    )
    expect(out.segments[0]?.freshness).toBe('warning')
    expect(out.segments[1]?.freshness).toBe('fresh')
    expect(out.segments[1]?.numbersSuspended).toBe(false)
  })

  it('uses the project thresholds', () => {
    const out = verifyAnswer(
      answer([segment('Budget di 1.200 €', [cite(OTHER_DOC)], 'fact')]),
      context({ thresholds: { warnAfterHours: 1, stopAfterHours: 4 } }),
    )
    expect(out.segments[0]?.freshness).toBe('stale')
    expect(out.segments[0]?.numbersSuspended).toBe(true)
  })

  it('refuses thresholds looser than the defaults', () => {
    expect(() =>
      verifyAnswer(
        answer([]),
        context({ thresholds: { warnAfterHours: 48, stopAfterHours: 200 } }),
      ),
    ).toThrow(DomainError)
  })

  it('a registered date more than a day ahead does not count for freshness and is an anomaly', () => {
    const out = verifyAnswer(
      answer([segment('Budget di 1.200 €', [cite(FRESH_DOC), cite(FUTURE_DOC)], 'fact')]),
      context(),
    )
    expect(out.segments[0]?.sources[1]).toMatchObject({
      verified: true,
      futureDate: true,
      freshness: null,
    })
    expect(out.segments[0]?.freshness).toBe('fresh')
    expect(out.segments[0]?.text).toBe('Budget di 1.200 €')
    expect(out.checks.list).toContainEqual({ code: 'future_source_date', index: 0 })
  })

  it('a future-dated source does not mask a stale one', () => {
    const out = verifyAnswer(
      answer([segment('Budget di 1.200 €', [cite(FUTURE_DOC), cite(STALE_DOC)], 'fact')]),
      context(),
    )
    expect(out.segments[0]).toMatchObject({
      freshness: 'stale',
      text: null,
      suspendedReason: 'stale_data',
    })
  })

  it('only future-dated sources: unknown freshness, and in-scope text suspended', () => {
    const out = verifyAnswer(
      answer([
        segment('Budget di 1.200 €', [cite(FUTURE_DOC)], 'fact'),
        segment('Il clima è buono', [cite(FUTURE_DOC)]),
      ]),
      context(),
    )
    expect(out.segments[0]).toMatchObject({
      freshness: 'unknown',
      withoutSource: false,
      text: null,
      suspendedReason: 'unknown_freshness',
    })
    expect(out.segments[1]).toMatchObject({ text: 'Il clima è buono', suspendedReason: null })
    expect(out.checks.list).toEqual([
      { code: 'future_source_date', index: 0 },
      { code: 'future_source_date', index: 1 },
    ])
  })

  it('system data its system did not date: unknown age, its numbers suspended', () => {
    const out = verifyAnswer(
      answer([
        segment('Ore registrate 1.200', [cite(UNDATED_DOC)], 'fact'),
        segment('Ore registrate 1.200', [cite(UNDATED_DOC), cite(FRESH_DOC)], 'fact'),
      ]),
      context(),
    )
    expect(out.segments[0]).toMatchObject({
      freshness: 'unknown',
      text: null,
      suspendedReason: 'unknown_freshness',
    })
    expect(out.segments[0]?.sources[0]).toMatchObject({ verified: true, sourceDate: null })
    // A dated source judges the segment; the undated one is still reported.
    expect(out.segments[1]).toMatchObject({ freshness: 'fresh', suspendedReason: null })
    expect(out.checks.list).toEqual([
      { code: 'unknown_source_freshness', index: 0 },
      { code: 'unknown_source_freshness', index: 1 },
    ])
  })

  it('a contradiction side with data and only a future-dated source is suspended', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction([side('1.200 €', cite(FUTURE_DOC)), side('1.500 €', cite(FRESH_DOC))]),
        ],
      }),
      context(),
    )
    expect(out.contradictions[0]?.sides[0]).toMatchObject({
      value: null,
      suspendedReason: 'unknown_freshness',
      freshness: 'unknown',
    })
    expect(out.checks.list).toEqual([{ code: 'future_source_date', index: 0, side: 0 }])
  })

  it('a registered date a few hours ahead is fresh (clocks and time zones)', () => {
    const out = verifyAnswer(
      answer([segment('Budget di 1.200 €', [cite(FRESH_DOC)], 'fact')]),
      context({ now: hoursAgo(10) }),
    )
    expect(out.segments[0]?.freshness).toBe('fresh')
  })
})

describe('verifyAnswer: contradictions', () => {
  it('shows every side of a contradiction between two documents, without resolving it', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction(
            [side('30 novembre', cite(FRESH_DOC)), side('15 dicembre', cite(OTHER_DOC))],
            'Consegna',
            'Le due fonti indicano date diverse',
          ),
        ],
      }),
      context(),
    )
    const [c] = out.contradictions
    expect(c?.sides.map((s) => s.value)).toEqual(['30 novembre', '15 dicembre'])
    expect(c?.sides.every((s) => s.source.verified)).toBe(true)
    expect(c).toMatchObject({
      subject: 'Consegna',
      reason: 'Le due fonti indicano date diverse',
      suppressed: false,
      sameDocument: false,
      allSidesVerified: true,
    })
    expect(out.checks.anomalies).toBe(0)
  })

  it('same-document contradiction is an anomaly', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction([side('1.200 €', cite(FRESH_DOC)), side('1.500 €', cite(FRESH_DOC))]),
        ],
      }),
      context(),
    )
    expect(out.contradictions[0]?.sameDocument).toBe(true)
    expect(out.contradictions[0]?.sides).toHaveLength(2)
    expect(out.checks.list).toEqual([{ code: 'same_document_contradiction', index: 0 }])
  })

  it('a side without a verified source is an anomaly and its value is not shown', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction([side('1.200 €', cite(FRESH_DOC)), side('1.500 €', cite(UNREAD_DOC))]),
        ],
      }),
      context(),
    )
    const c = out.contradictions[0]
    expect(c?.allSidesVerified).toBe(false)
    expect(c?.sides[0]?.value).toBe('1.200 €')
    expect(c?.sides[1]).toMatchObject({
      value: null,
      originalValue: '1.500 €',
      suspendedReason: 'without_source',
    })
    expect(out.checks.list).toEqual([{ code: 'contradiction_unverified_side', index: 0, side: 1 }])
  })

  it('a stale side with data has its value suspended; a qualitative stale side stays', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction([side('1.200 €', cite(FRESH_DOC)), side('80.000 €', cite(STALE_DOC))]),
          contradiction([side('in linea', cite(FRESH_DOC)), side('in ritardo', cite(STALE_DOC))]),
          contradiction([side('Acme', cite(FRESH_DOC)), side('Mario Rossi', cite(STALE_DOC))]),
        ],
      }),
      context(),
    )
    expect(out.contradictions[0]?.sides[1]).toMatchObject({
      value: null,
      originalValue: '80.000 €',
      suspendedReason: 'stale_data',
      warning: 'stale',
    })
    expect(out.contradictions[1]?.sides[1]).toMatchObject({
      value: 'in ritardo',
      suspendedReason: null,
      warning: 'stale',
    })
    expect(out.contradictions[2]?.sides[1]?.value).toBeNull()
    expect(out.checks.list).toEqual([
      { code: 'contradiction_stale_side', index: 0, side: 1 },
      { code: 'contradiction_stale_side', index: 2, side: 1 },
    ])
  })

  it('a subject or reason with data is suppressed and kept for audit', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction(
            [side('in linea', cite(FRESH_DOC)), side('in ritardo', cite(OTHER_DOC))],
            'Stato al 30/10',
            'Divergono',
          ),
          contradiction(
            [side('in linea', cite(FRESH_DOC)), side('in ritardo', cite(OTHER_DOC))],
            'Stato',
            'Divergono da tre settimane',
          ),
        ],
      }),
      context(),
    )
    expect(out.contradictions[0]).toMatchObject({
      subject: null,
      reason: null,
      originalSubject: 'Stato al 30/10',
      originalReason: 'Divergono',
      suppressed: true,
    })
    expect(out.contradictions[1]?.suppressed).toBe(true)
    expect(out.checks.list).toEqual([
      { code: 'contradiction_with_data', index: 0 },
      { code: 'contradiction_with_data', index: 1 },
    ])
  })
})

describe('verifyAnswer: absences', () => {
  it('absence with a number is an anomaly', () => {
    const out = verifyAnswer(
      answer([], {
        absences: [
          { question: 'Qual è il budget del 2027?', proposal: 'Chiedi al cliente' },
          { question: 'Chi approva il piano?', proposal: 'Indica il referente entro 3 giorni' },
          { question: 'Chi approva il piano?', proposal: 'Chiedilo allo sponsor' },
        ],
      }),
      context(),
    )
    expect(out.absences.map((a) => a.suppressed)).toEqual([true, true, false])
    expect(out.absences[0]).toMatchObject({
      question: null,
      proposal: null,
      originalQuestion: 'Qual è il budget del 2027?',
      originalProposal: 'Chiedi al cliente',
    })
    expect(out.absences[2]).toMatchObject({
      question: 'Chi approva il piano?',
      proposal: 'Chiedilo allo sponsor',
    })
    expect(out.checks.list).toEqual([
      { code: 'absence_with_data', index: 0 },
      { code: 'absence_with_data', index: 1 },
    ])
  })

  it('an absence with a date, an identifier or a number in words is an anomaly', () => {
    const out = verifyAnswer(
      answer([], {
        absences: [
          { question: 'Cosa succede a dicembre?', proposal: 'Chiedi al PMO' },
          { question: 'Serve il ticket PROJ-12?', proposal: 'Verifica' },
          {
            question: 'Vale il documento 0f8fad5b-d9cb-469f-a165-70867728950e?',
            proposal: 'Verifica',
          },
          { question: 'Chi approva?', proposal: 'Chiedi entro due settimane' },
          { question: 'Chi approva?', proposal: 'Chiedi domani' },
        ],
      }),
      context(),
    )
    expect(out.absences.map((a) => a.suppressed)).toEqual([true, true, true, true, true])
  })
})

describe('verifyAnswer: numbers in words', () => {
  it('a lone small number word in a source does not support a number', () => {
    const log = readLog()
    log.recordEvidence(PLAN_TWO, [
      { locator: PAGE_2, numbers: shownNumbersIn("Se sei d'accordo, procediamo", 'it') },
    ])
    log.recordEvidence(PLAN_THREE, [
      { locator: PAGE_2, numbers: shownNumbersIn('durata sei mesi', 'it') },
    ])
    const out = verifyAnswer(
      answer([
        segment('La fase dura 6 mesi', [cite(PLAN_TWO, PAGE_2)]),
        segment('La fase dura 6 mesi', [cite(PLAN_THREE, PAGE_2)]),
      ]),
      context({ read: log.snapshot() }),
    )
    expect(out.segments[0]?.sources[0]?.reason).toBe('numbers_not_in_source')
    expect(out.segments[0]?.withoutSource).toBe(true)
    expect(out.segments[1]?.withoutSource).toBe(false)
  })

  it('a number in words must be in the source too', () => {
    const out = verifyAnswer(
      answer([
        segment('Mancano tre settimane', [cite(PLAN_TWO)]),
        segment('Mancano tre settimane', [cite(PLAN_THREE)]),
        segment('Mancano 3 settimane', [cite(PLAN_THREE)]),
      ]),
      context(),
    )
    expect(out.segments[0]?.sources[0]?.reason).toBe('numbers_not_in_source')
    expect(out.segments[0]?.withoutSource).toBe(true)
    expect(out.segments[1]?.withoutSource).toBe(false)
    expect(out.segments[2]?.withoutSource).toBe(false)
  })

  it('ordinary sentences with number-like words stay out of scope', () => {
    const out = verifyAnswer(
      answer([
        segment('Uno dei rischi principali è il fornitore', []),
        segment("Se sei d'accordo, procediamo", []),
        segment('Le due squadre lavorano bene', []),
        segment('Il problema è a metà strada', []),
      ]),
      context(),
    )
    expect(out.segments.map((s) => s.inScope)).toEqual([false, false, false, false])
  })
})

describe('verifyAnswer: names outside segments', () => {
  it('an absence or a contradiction text that names a known person is suppressed', () => {
    const out = verifyAnswer(
      answer([], {
        contradictions: [
          contradiction(
            [side('in linea', cite(FRESH_DOC)), side('in ritardo', cite(OTHER_DOC))],
            'Ruolo di Acme',
          ),
        ],
        absences: [{ question: 'Chi approva?', proposal: 'Chiedi a Mario Rossi' }],
      }),
      context(),
    )
    expect(out.contradictions[0]).toMatchObject({ subject: null, suppressed: true })
    expect(out.absences[0]).toMatchObject({ proposal: null, suppressed: true })
    expect(out.checks.list).toEqual([
      { code: 'contradiction_with_name', index: 0 },
      { code: 'absence_with_name', index: 0 },
    ])
  })
})

describe('verifyAnswer: mixed scripts', () => {
  it('a word mixing Latin and Cyrillic letters is in scope and an anomaly', () => {
    const out = verifyAnswer(
      answer([segment('Ne parla M\u0430rio Rossi', [])], {
        absences: [{ question: 'Chi \u0430pprova?', proposal: 'Chiedi' }],
      }),
      context(),
    )
    expect(out.segments[0]).toMatchObject({ inScope: true, mixedScript: true, text: null })
    expect(out.absences[0]?.suppressed).toBe(true)
    expect(out.checks.list).toEqual([
      { code: 'mixed_script', index: 0 },
      { code: 'without_source', index: 0 },
      { code: 'absence_with_mixed_script', index: 0 },
    ])
  })

  it('a word of one script only is not mixed', () => {
    const out = verifyAnswer(answer([segment('Il team \u0410\u0411\u0412 è ok', [])]), context())
    expect(out.segments[0]?.mixedScript).toBe(false)
  })
})

describe('verifyAnswer: language', () => {
  it('uses the language of the run; a different language from the model is an anomaly', () => {
    const out = verifyAnswer({ ...answer([]), lang: 'en' } as unknown as ModelAnswer, context())
    expect(out.lang).toBe('it')
    expect(out.checks.list).toEqual([{ code: 'lang_mismatch', index: 0 }])
  })
})

describe('verifyAnswer: checks', () => {
  it('counts the checks performed and the anomalies found', () => {
    const out = verifyAnswer(
      answer(
        [
          segment('Il budget è di 1.200 €', [cite(FRESH_DOC)], 'fact'),
          segment('Avanzamento al 70%', []),
          segment('Il clima è buono', []),
        ],
        {
          contradictions: [
            contradiction([side('1.200 €', cite(FRESH_DOC)), side('1.500 €', cite(FRESH_DOC))]),
          ],
          absences: [{ question: 'Chi approva?', proposal: 'Chiedi allo sponsor' }],
        },
      ),
      context(),
    )
    // 1 language + 3 segments × 3 + 2 sides × 2 + 1 contradiction × 2 + 1 absence.
    expect(out.checks.total).toBe(17)
    expect(out.checks.anomalies).toBe(2)
    expect(out.checks.list).toEqual([
      { code: 'without_source', index: 1 },
      { code: 'same_document_contradiction', index: 0 },
    ])
    expect(out.lang).toBe('it')
  })

  it('an empty answer has only the language check and no anomalies', () => {
    expect(verifyAnswer(answer([]), context()).checks).toEqual({
      total: 1,
      anomalies: 0,
      list: [],
    })
  })
})
