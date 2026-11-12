import { describe, expect, it } from 'vitest'
import {
  createReadLog,
  DEFAULT_FRESHNESS,
  EVENT_DOCUMENT_KINDS,
  type EvidenceId,
  type FactId,
  factPolicy,
  freshnessPolicyOf,
  hasVersions,
  type Locator,
  type ModelAnswer,
  type RegisteredSource,
  rehydrateVerifiedAnswer,
  type SourceRegistry,
  sourceFreshnessOf,
  sourcePolicies,
  systemLeftUndated,
  type VerifiedAnswer,
  verifyAnswer,
} from '../src/index.ts'

const NOW = new Date('2026-11-05T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
const PAGE: Locator = { kind: 'page', page: 1 }

const SAL_OLD = 'e-sal-old' as EvidenceId
const BACKLOG_OLD = 'e-backlog-old' as EvidenceId
const SAL_SUPERSEDED = 'e-sal-superseded' as EvidenceId
const BACKLOG_FRESH = 'e-backlog-fresh' as EvidenceId
const PM_FACT = 'f-pm' as FactId
const SYSTEM_FACT = 'f-system' as FactId

const doc = (
  title: string,
  hours: number,
  freshnessPolicy: 'system' | 'document',
  superseded = false,
): RegisteredSource => ({
  title,
  sourceDate: hoursAgo(hours),
  dateSource: 'file_name',
  freshnessPolicy,
  superseded,
})

const evidences: Record<string, RegisteredSource> = {
  [SAL_OLD]: doc('SAL ottobre', 129, 'document'),
  [BACKLOG_OLD]: doc('Export backlog', 129, 'system'),
  [SAL_SUPERSEDED]: doc('SAL settembre', 30, 'document', true),
  [BACKLOG_FRESH]: doc('Export backlog di oggi', 2, 'system'),
}

const registry: SourceRegistry = {
  tracker: () => null,
  evidence: (id) => evidences[id] ?? null,
  fact: (id) => {
    if (id === PM_FACT) {
      // The registry says system: a fact stated by the PM follows the document policy anyway.
      return { ...doc('status:fase', 129, 'system'), pmAsserted: true, contested: false }
    }
    if (id === SYSTEM_FACT) {
      return { ...doc('economics:ore', 129, 'system'), pmAsserted: false, contested: false }
    }
    return null
  },
}

function verify(segments: ModelAnswer['segments'], rest: Partial<ModelAnswer> = {}) {
  const log = createReadLog()
  for (const id of Object.keys(evidences)) {
    log.recordEvidence(id as EvidenceId, [{ locator: PAGE, numbers: ['62', '1200'] }])
  }
  log.recordFact(PM_FACT, ['62'])
  log.recordFact(SYSTEM_FACT, ['62'])
  return verifyAnswer(
    { lang: 'it', segments, contradictions: [], absences: [], ...rest },
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

const cite = (evidenceId: EvidenceId) => ({ evidenceId, locator: PAGE })

describe('freshness policy of a source', () => {
  it('is system for a system connector, whatever the kind of document', () => {
    expect(freshnessPolicyOf('ado', 'status_report')).toBe('system')
    expect(freshnessPolicyOf('jira', null)).toBe('system')
    expect(freshnessPolicyOf('dwsi', 'generic')).toBe('system')
  })

  it('is system for an export of a system, whatever the connector', () => {
    expect(freshnessPolicyOf('manual_upload', 'backlog_export')).toBe('system')
    expect(freshnessPolicyOf('m365', 'timesheet')).toBe('system')
    expect(freshnessPolicyOf('manual_upload', 'economics_export')).toBe('system')
  })

  it('is document for documentary connectors and every other kind', () => {
    for (const kind of ['status_report', 'meeting_minutes', 'contract', 'generic'] as const) {
      expect(freshnessPolicyOf('manual_upload', kind)).toBe('document')
    }
    expect(freshnessPolicyOf('m365', 'transcript')).toBe('document')
    expect(freshnessPolicyOf('m365', null)).toBe('document')
  })

  it('a document beyond the stop threshold is only dated', () => {
    const out = sourceFreshnessOf(hoursAgo(129), NOW, DEFAULT_FRESHNESS, 'document')
    expect(out.level).toBe('dated')
    expect(out.ageHours).toBeCloseTo(129)
    expect(sourceFreshnessOf(hoursAgo(129), NOW, DEFAULT_FRESHNESS, 'system').level).toBe('stale')
  })
})

describe('superseded documents', () => {
  const at = (h: number) => hoursAgo(h)

  it('an older document of the same kind is superseded by a newer one', () => {
    const out = sourcePolicies([
      { id: 'sal-1', sourceKind: 'manual_upload', documentKind: 'status_report', date: at(400) },
      { id: 'sal-2', sourceKind: 'manual_upload', documentKind: 'status_report', date: at(30) },
      { id: 'min-1', sourceKind: 'manual_upload', documentKind: 'meeting_minutes', date: at(500) },
    ])
    expect(out.get('sal-1')).toEqual({ freshnessPolicy: 'document', superseded: true })
    expect(out.get('sal-2')).toEqual({ freshnessPolicy: 'document', superseded: false })
    expect(out.get('min-1')).toEqual({ freshnessPolicy: 'document', superseded: false })
  })

  it('a system export is never superseded: its age already speaks', () => {
    const out = sourcePolicies([
      { id: 'b-1', sourceKind: 'manual_upload', documentKind: 'backlog_export', date: at(400) },
      { id: 'b-2', sourceKind: 'manual_upload', documentKind: 'backlog_export', date: at(3) },
    ])
    expect(out.get('b-1')).toEqual({ freshnessPolicy: 'system', superseded: false })
  })

  it('unclassified and generic documents are never superseded', () => {
    const out = sourcePolicies([
      { id: 'g-1', sourceKind: 'manual_upload', documentKind: 'generic', date: at(400) },
      { id: 'g-2', sourceKind: 'manual_upload', documentKind: 'generic', date: at(3) },
      { id: 'u-1', sourceKind: 'manual_upload', documentKind: null, date: at(400) },
      { id: 'u-2', sourceKind: 'manual_upload', documentKind: null, date: at(3) },
    ])
    expect([...out.values()].every((p) => !p.superseded)).toBe(true)
  })

  it('recurring meetings do not supersede each other', () => {
    const out = sourcePolicies([
      { id: 't-1', sourceKind: 'files', documentKind: 'transcript', date: at(400) },
      { id: 't-2', sourceKind: 'files', documentKind: 'transcript', date: at(30) },
      { id: 'm-1', sourceKind: 'manual_upload', documentKind: 'meeting_minutes', date: at(400) },
      { id: 'm-2', sourceKind: 'manual_upload', documentKind: 'meeting_minutes', date: at(30) },
      { id: 'o-1', sourceKind: 'manual_upload', documentKind: 'purchase_order', date: at(400) },
      { id: 'o-2', sourceKind: 'manual_upload', documentKind: 'purchase_order', date: at(30) },
      { id: 'i-1', sourceKind: 'manual_upload', documentKind: 'invoice', date: at(400) },
      { id: 'i-2', sourceKind: 'manual_upload', documentKind: 'invoice', date: at(30) },
    ])
    expect([...out.values()].every((p) => !p.superseded)).toBe(true)
    expect(EVENT_DOCUMENT_KINDS.every((kind) => !hasVersions(kind))).toBe(true)
  })

  it('a versioned report is still superseded by a newer one', () => {
    const out = sourcePolicies([
      { id: 'sal-1', sourceKind: 'files', documentKind: 'status_report', date: at(400) },
      { id: 'sal-2', sourceKind: 'files', documentKind: 'status_report', date: at(30) },
      { id: 'p-1', sourceKind: 'manual_upload', documentKind: 'presentation', date: at(400) },
      { id: 'p-2', sourceKind: 'manual_upload', documentKind: 'presentation', date: at(30) },
      { id: 'c-1', sourceKind: 'manual_upload', documentKind: 'contract', date: at(400) },
      { id: 'c-2', sourceKind: 'manual_upload', documentKind: 'contract', date: at(30) },
    ])
    expect(out.get('sal-1')?.superseded).toBe(true)
    expect(out.get('p-1')?.superseded).toBe(true)
    expect(out.get('c-1')?.superseded).toBe(true)
    expect(out.get('sal-2')?.superseded).toBe(false)
    expect(hasVersions('status_report')).toBe(true)
    expect(hasVersions('generic')).toBe(false)
  })

  it('a document of the same date is not superseded', () => {
    const out = sourcePolicies([
      { id: 'a', sourceKind: 'manual_upload', documentKind: 'contract', date: at(10) },
      { id: 'b', sourceKind: 'manual_upload', documentKind: 'contract', date: at(10) },
    ])
    expect(out.get('a')?.superseded).toBe(false)
  })
})

describe('freshness policy of a fact', () => {
  it('a fact stated by the PM follows the document policy', () => {
    expect(factPolicy([{ freshnessPolicy: 'system', superseded: false }], true)).toEqual({
      freshnessPolicy: 'document',
      superseded: false,
    })
  })

  it('is system when any of its sources is system', () => {
    expect(
      factPolicy(
        [
          { freshnessPolicy: 'document', superseded: true },
          { freshnessPolicy: 'system', superseded: false },
        ],
        false,
      ),
    ).toEqual({ freshnessPolicy: 'system', superseded: false })
  })

  it('is superseded only when every source of it is', () => {
    const old = { freshnessPolicy: 'document', superseded: true } as const
    const current = { freshnessPolicy: 'document', superseded: false } as const
    expect(factPolicy([old, old], false).superseded).toBe(true)
    expect(factPolicy([old, current], false).superseded).toBe(false)
    expect(factPolicy([], false)).toEqual({ freshnessPolicy: 'document', superseded: false })
  })
})

describe('verifyAnswer: freshness thresholds apply to system data only', () => {
  it('a document 129 hours old is not suspended and carries no age warning', () => {
    const out = verify([
      { text: "L'avanzamento è al 62%", nature: 'fact', sources: [cite(SAL_OLD)] },
    ])
    const [seg] = out.segments
    expect(seg?.text).toBe("L'avanzamento è al 62%")
    expect(seg?.suspendedReason).toBeNull()
    expect(seg?.freshness).toBe('dated')
    expect(seg?.warning).toBeNull()
    expect(seg?.sources[0]).toMatchObject({ freshnessPolicy: 'document', superseded: false })
    expect(seg?.sources[0]?.freshness?.level).toBe('dated')
    expect(seg?.sources[0]?.freshness?.ageHours).toBeCloseTo(129)
    expect(out.checks.anomalies).toBe(0)
  })

  it('a system export 129 hours old has its numbers suspended', () => {
    const out = verify([
      { text: 'Restano 62 storie aperte', nature: 'fact', sources: [cite(BACKLOG_OLD)] },
    ])
    const [seg] = out.segments
    expect(seg?.text).toBeNull()
    expect(seg?.suspendedReason).toBe('stale_data')
    expect(seg?.warning).toBe('stale')
    expect(seg?.sources[0]?.freshnessPolicy).toBe('system')
    expect(out.checks.list).toContainEqual({ code: 'stale_data', index: 0 })
  })

  it('a superseded document gives the superseded warning, never an anomaly', () => {
    const out = verify([
      { text: "L'avanzamento è al 62%", nature: 'fact', sources: [cite(SAL_SUPERSEDED)] },
    ])
    const [seg] = out.segments
    expect(seg?.text).toBe("L'avanzamento è al 62%")
    expect(seg?.warning).toBe('superseded')
    expect(seg?.sources[0]?.superseded).toBe(true)
    expect(out.checks.anomalies).toBe(0)
  })

  it('a segment backed also by a current source is not marked superseded', () => {
    const out = verify([
      {
        text: "L'avanzamento è al 62%",
        nature: 'fact',
        sources: [cite(SAL_SUPERSEDED), cite(SAL_OLD)],
      },
    ])
    expect(out.segments[0]?.warning).toBeNull()
  })

  it('an age warning of a system source wins over the superseded one', () => {
    const out = verify([
      {
        text: 'Lo stato è verde',
        nature: 'inference',
        sources: [cite(SAL_SUPERSEDED), cite(BACKLOG_OLD)],
      },
    ])
    expect(out.segments[0]?.warning).toBe('stale')
  })

  it('with a fresh system source and a document, the segment is fresh', () => {
    const out = verify([
      {
        text: "L'avanzamento è al 62%",
        nature: 'fact',
        sources: [cite(SAL_OLD), cite(BACKLOG_FRESH)],
      },
    ])
    expect(out.segments[0]?.freshness).toBe('fresh')
  })

  it('a fact stated by the PM follows the document policy, whatever the registry says', () => {
    const out = verify([
      { text: "L'avanzamento è al 62%", nature: 'fact', sources: [{ factId: PM_FACT }] },
    ])
    const [seg] = out.segments
    expect(seg?.text).toBe("L'avanzamento è al 62%")
    expect(seg?.sources[0]).toMatchObject({ freshnessPolicy: 'document', pmAsserted: true })
    expect(seg?.freshness).toBe('dated')
  })

  it('a fact of system data beyond the stop is suspended', () => {
    const out = verify([
      { text: 'Le ore sono 62', nature: 'fact', sources: [{ factId: SYSTEM_FACT }] },
    ])
    expect(out.segments[0]?.suspendedReason).toBe('stale_data')
  })

  it('a side of a contradiction from an old document stays shown', () => {
    const out = verify([], {
      contradictions: [
        {
          subject: 'Avanzamento',
          reason: 'Le fonti divergono',
          sides: [
            { value: '62%', source: cite(SAL_OLD) },
            { value: '1.200 ore', source: cite(BACKLOG_OLD) },
          ],
        },
      ],
    })
    const [first, second] = out.contradictions[0]?.sides ?? []
    expect(first?.value).toBe('62%')
    expect(first?.freshness).toBe('dated')
    expect(first?.warning).toBeNull()
    expect(second?.value).toBeNull()
    expect(second?.suspendedReason).toBe('stale_data')
  })
})

describe('stored answers and the freshness policy', () => {
  const sample = (): VerifiedAnswer =>
    verify(
      [
        { text: "L'avanzamento è al 62%", nature: 'fact', sources: [cite(SAL_OLD)] },
        { text: "L'avanzamento è al 62%", nature: 'fact', sources: [cite(SAL_SUPERSEDED)] },
        { text: 'Restano 62 storie aperte', nature: 'fact', sources: [cite(BACKLOG_OLD)] },
      ],
      {
        contradictions: [
          {
            subject: 'Avanzamento',
            reason: 'Le fonti divergono',
            sides: [
              { value: '62%', source: cite(SAL_SUPERSEDED) },
              { value: '1.200 ore', source: cite(BACKLOG_FRESH) },
            ],
          },
        ],
      },
    )
  const json = (a: VerifiedAnswer) => JSON.parse(JSON.stringify(a))

  it('round trips with the policy, the dated level and the superseded warning', () => {
    const answer = sample()
    expect(rehydrateVerifiedAnswer(json(answer))).toEqual(answer)
  })

  it('an answer stored before the policy existed still reads back, as system data', () => {
    // biome-ignore lint/suspicious/noExplicitAny: a stored JSON shaped as the old answers were
    const old: any = json(
      verify([{ text: 'Restano 62 storie aperte', nature: 'fact', sources: [cite(BACKLOG_OLD)] }]),
    )
    for (const seg of old.segments) {
      for (const s of seg.sources) {
        delete s.freshnessPolicy
        delete s.superseded
      }
    }
    const back = rehydrateVerifiedAnswer(old)
    expect(back.segments[0]?.sources[0]).toMatchObject({
      freshnessPolicy: 'system',
      superseded: false,
    })
    expect(back.segments[0]?.suspendedReason).toBe('stale_data')
  })

  it('refuses a dated level on a system source, and an age level on a document', () => {
    const datedSystem = json(sample())
    datedSystem.segments[2].sources[0].freshness.level = 'dated'
    expect(() => rehydrateVerifiedAnswer(datedSystem)).toThrow()
    const agedDocument = json(sample())
    agedDocument.segments[0].sources[0].freshness.level = 'stale'
    expect(() => rehydrateVerifiedAnswer(agedDocument)).toThrow()
  })

  it('refuses a superseded system source and an unknown policy', () => {
    const supersededSystem = json(sample())
    supersededSystem.segments[2].sources[0].superseded = true
    expect(() => rehydrateVerifiedAnswer(supersededSystem)).toThrow()
    const unknown = json(sample())
    unknown.segments[0].sources[0].freshnessPolicy = 'connector'
    expect(() => rehydrateVerifiedAnswer(unknown)).toThrow()
  })
})

describe('system data its system did not date', () => {
  it('is of unknown age when a connector of a system read it and the system gave no date', () => {
    expect(
      systemLeftUndated({
        sourceKind: 'dwsi',
        originSource: 'acquisition',
        dateSource: 'acquisition',
      }),
    ).toBe(true)
    // Whatever the classification guessed from the title: never the time of the read.
    expect(
      systemLeftUndated({
        sourceKind: 'ado',
        originSource: 'acquisition',
        dateSource: 'file_name',
      }),
    ).toBe(true)
  })

  it('is dated when the system dated it, or the PM did', () => {
    expect(
      systemLeftUndated({
        sourceKind: 'dwsi',
        originSource: 'system',
        dateSource: 'system',
      }),
    ).toBe(false)
    expect(
      systemLeftUndated({
        sourceKind: 'dwsi',
        originSource: 'acquisition',
        dateSource: 'pm',
      }),
    ).toBe(false)
  })

  it('never applies to an upload or a document connector, dated as before', () => {
    for (const sourceKind of ['manual_upload', 'm365', 'm365', 'm365'] as const) {
      expect(
        systemLeftUndated({ sourceKind, originSource: 'acquisition', dateSource: 'acquisition' }),
      ).toBe(false)
    }
  })
})
