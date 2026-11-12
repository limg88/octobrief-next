import { describe, expect, it } from 'vitest'
import {
  type AnswerSourceRef,
  createReadLog,
  DEFAULT_FRESHNESS,
  dayLabels,
  type FactId,
  groupCountedRows,
  isTrackerLocator,
  type SourceId,
  trackerDataAsOf,
  trackerLocatorKey,
  trackerQueryId,
  verifyAnswer,
} from '../src/index.ts'

const NOW = new Date('2026-11-05T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
const S = 'a0000000-0000-4000-8000-000000000001' as SourceId
const FACT_A = 'f0000000-0000-4000-8000-00000000000a'
const FACT_B = 'f0000000-0000-4000-8000-00000000000b'

describe('the counts of one call', () => {
  it('are a place of their own, by the id of the call', () => {
    expect(trackerQueryId(2)).toBe('q2')
    expect(isTrackerLocator({ kind: 'work_item_counts', query: 'q2' })).toBe(true)
    expect(isTrackerLocator({ kind: 'work_item_counts', query: 'q0' })).toBe(false)
    expect(isTrackerLocator({ kind: 'work_item_counts', query: 'x' })).toBe(false)
    expect(isTrackerLocator({ kind: 'work_item_counts', query: 2 })).toBe(false)
    expect(trackerLocatorKey({ kind: 'work_item_counts', query: 'q2' })).toBe('work_item_counts:q2')
  })
})

describe('the labels of a tracker read', () => {
  type Read = { query: string; numbers: string[]; labels?: string[]; days?: string[] }
  const registry = {
    evidence: () => null,
    fact: () => ({
      title: 'Fatto',
      sourceDate: hoursAgo(1),
      dateSource: 'system' as const,
      freshnessPolicy: 'document' as const,
      superseded: false,
      pmAsserted: false,
      contested: false,
    }),
    tracker: () => ({
      title: 'Azure DevOps',
      sourceDate: hoursAgo(1),
      dateSource: 'system' as const,
      freshnessPolicy: 'system' as const,
      superseded: false,
    }),
  }
  const check = (
    text: string,
    reads: Read[],
    cited: string[],
    facts: Record<string, string[]> = {},
  ) => {
    const log = createReadLog()
    for (const [id, numbers] of Object.entries(facts)) log.recordFact(id as FactId, numbers)
    for (const r of reads) {
      log.recordTracker(S, [
        {
          locator: { kind: 'work_item_counts', query: r.query },
          numbers: r.numbers,
          ...(r.labels ? { labels: r.labels } : {}),
          ...(r.days ? { days: r.days } : {}),
        },
      ])
    }
    return verifyAnswer(
      {
        lang: 'it',
        segments: [
          {
            text,
            nature: 'fact',
            sources: cited.map(
              (query): AnswerSourceRef =>
                query in facts
                  ? { factId: query as FactId }
                  : { sourceId: S, locator: { kind: 'work_item_counts', query } },
            ),
          },
        ],
        contradictions: [],
        absences: [],
      },
      {
        lang: 'it',
        read: log.snapshot(),
        registry,
        thresholds: DEFAULT_FRESHNESS,
        now: NOW,
        knownNames: [],
      },
    ).segments[0]
  }
  const verify = (text: string, query = 'q1') =>
    check(
      text,
      [
        {
          query: 'q1',
          numbers: ['4'],
          labels: ['Sprint 12', 'Sprint Alpha'],
          days: ['2026-10-01'],
        },
      ],
      [query],
    )
  const withLabel = (label: string, text: string) =>
    check(text, [{ query: 'q1', numbers: ['4'], labels: [label] }], ['q1'])

  it('let a sentence name the group and the day shown, never use their digits as a count', () => {
    expect(verify('Nello sprint 12 ci sono 4 work item')?.text).not.toBeNull()
    expect(verify('Lo Sprint Alpha ha 4 work item')?.text).not.toBeNull()
    expect(verify('Al 1 ottobre 2026 erano 4 work item')?.text).not.toBeNull()
    expect(verify('Al 01/10/2026 erano 4 work item')?.text).not.toBeNull()
    expect(verify('Ci sono 12 work item')?.suspendedReason).toBe('without_source')
    expect(verify('Nello Sprint 12 ci sono 12 work item')?.suspendedReason).toBe('without_source')
    expect(verify('Al 2 ottobre 2026 erano 4 work item')?.suspendedReason).toBe('without_source')
    expect(verify('Sprint 123 ha 4 work item')?.suspendedReason).toBe('without_source')
    // A day without its year is no label: «1/10» could be anything.
    expect(verify('Al 1/10 erano 4 work item')?.suspendedReason).toBe('without_source')
  })

  it('never let a group name of digits or of number words carry a number', () => {
    expect(withLabel('15', 'Ci sono 15 work item')?.suspendedReason).toBe('without_source')
    expect(withLabel('2026', 'Nel 2026 ci sono 2026 work item')?.suspendedReason).toBe(
      'without_source',
    )
    expect(withLabel('26.1', 'Ci sono 26.1 story point')?.suspendedReason).toBe('without_source')
    expect(withLabel('Due', 'Ci sono due work item in due settimane')?.suspendedReason).toBe(
      'without_source',
    )
    expect(withLabel('Otto', 'Ci sono otto settimane')?.suspendedReason).toBe('without_source')
    expect(withLabel('Sprint Alpha', 'Lo Sprint Alpha ha 4 work item')?.text).not.toBeNull()
  })

  it('never pair the day of one call with the count of another', () => {
    const reads: Read[] = [
      { query: 'q1', numbers: ['5'], days: ['2026-10-01'] },
      { query: 'q2', numbers: ['9'] },
    ]
    expect(
      check("Al 1 ottobre 2026 c'erano 9 work item", reads, ['q1', 'q2'])?.suspendedReason,
    ).toBe('without_source')
    expect(check("Al 1 ottobre 2026 c'erano 5 work item", reads, ['q1', 'q2'])?.text).not.toBeNull()
    // Without a label the numbers may come from the union of the citations.
    expect(check('Ci sono 5 e 9 work item', reads, ['q1', 'q2'])?.text).not.toBeNull()
  })

  it('lets a citation whose label a sentence uses cover every number of it alone', () => {
    const reads: Read[] = [
      { query: 'q1', numbers: ['5'], labels: ['Sprint 7'] },
      { query: 'q2', numbers: ['9'] },
    ]
    expect(check('Lo Sprint 7 ha 9 work item', reads, ['q1', 'q2'])?.suspendedReason).toBe(
      'without_source',
    )
    expect(check('Lo Sprint 7 ha 5 work item', reads, ['q1', 'q2'])?.text).not.toBeNull()
    const shown: Read[] = [
      { query: 'q1', numbers: ['5'], labels: ['Sprint 7'] },
      { query: 'q2', numbers: ['9', '7'] },
    ]
    expect(check('Lo Sprint 7 ha 9 work item', shown, ['q1', 'q2'])?.suspendedReason).toBe(
      'without_source',
    )
    const withFact = [{ query: 'q1', numbers: ['5'], labels: ['Sprint 7'] }]
    expect(
      check('Lo Sprint 7 costa 100 euro', withFact, ['q1', FACT_A], { [FACT_A]: ['100'] })
        ?.suspendedReason,
    ).toBe('without_source')
  })

  it('takes the numbers of two documents from either of them', () => {
    const facts = { [FACT_A]: ['100'], [FACT_B]: ['80'] }
    expect(
      check('Il budget è di 100 euro e la spesa è di 80 euro', [], [FACT_A, FACT_B], facts)?.text,
    ).not.toBeNull()
    expect(
      check('Il budget è di 100 euro e la spesa è di 70 euro', [], [FACT_A, FACT_B], facts)
        ?.suspendedReason,
    ).toBe('without_source')
  })

  it('needs one citation to cover every number of the sentence', () => {
    const reads: Read[] = [
      { query: 'q1', numbers: ['5'], days: ['2026-10-01'] },
      { query: 'q2', numbers: ['9'], labels: ['Sprint 7'] },
    ]
    expect(
      check('Al 1 ottobre 2026 lo Sprint 7 aveva 9 work item', reads, ['q1', 'q2'])
        ?.suspendedReason,
    ).toBe('without_source')
    const sprint: Read[] = [{ query: 'q1', numbers: ['5'], labels: ['Sprint 7'] }]
    expect(check('Lo Sprint 7 ha 5 work item', sprint, ['q1'])?.text).not.toBeNull()
  })

  it('never lets a label stand in for a quantity', () => {
    const label = (name: string, text: string) =>
      check(text, [{ query: 'q1', numbers: ['4'], labels: [name] }], ['q1'])
    expect(label('ha 40', 'Il progetto ha 40 work item')?.suspendedReason).toBe('without_source')
    expect(label('x 40', 'Sono x 40 work item')?.suspendedReason).toBe('without_source')
    expect(label('Sprint 7', 'Lo Sprint 7 ore')?.suspendedReason).toBe('without_source')
  })

  it('excuses a day without its year only when the sentence claims no other year', () => {
    const reads: Read[] = [{ query: 'q1', numbers: ['5'], days: ['2026-10-01'] }]
    expect(check('Al 1 ottobre erano 5 work item', reads, ['q1'])?.text).not.toBeNull()
    expect(check('Al 1 ottobre, nel 2025, erano 5 work item', reads, ['q1'])?.suspendedReason).toBe(
      'without_source',
    )
    expect(check('Al 1 ottobre 2025 erano 5 work item', reads, ['q1'])?.suspendedReason).toBe(
      'without_source',
    )
  })

  it('belong to their call only', () => {
    expect(verify('Ci sono 4 work item', 'q2')?.suspendedReason).toBe('without_source')
  })

  it('write a day in every usual form, and nothing for what is not a day', () => {
    expect(dayLabels('2026-10-01', 'it')).toEqual(
      expect.arrayContaining([
        '2026-10-01',
        '01/10/2026',
        '1/10/2026',
        '1 ottobre 2026',
        '1° ottobre',
      ]),
    )
    expect(dayLabels('2026-10-01', 'it')).not.toContain('01/10')
    expect(dayLabels('2026-10-01', 'it')).not.toContain('1/10')
    expect(dayLabels('2026-02-30', 'it')).toEqual([])
  })

  it('are kept by the read log, merged across reads', () => {
    const log = createReadLog()
    const locator = { kind: 'work_item_counts', query: 'q1' } as const
    log.recordTracker(S, [{ locator, numbers: ['1'], labels: ['A'] }])
    log.recordTracker(S, [{ locator, numbers: ['2'], labels: ['B'] }])
    log.recordTracker(S, [{ locator: { kind: 'work_item', id: '7' }, numbers: ['7'] }])
    const [entry] = log.snapshot().entries
    expect(entry).toEqual({
      trackerSourceId: S,
      reads: [
        { locator, numbers: ['1', '2'], labels: ['A', 'B'] },
        { locator: { kind: 'work_item', id: '7' }, numbers: ['7'] },
      ],
    })
  })
})

describe('the age of a tracker', () => {
  it('is unknown before its first completed sync', () => {
    expect(
      trackerDataAsOf({ pending: true, lastSuccessAt: null, dataAsOf: hoursAgo(1) }),
    ).toBeNull()
  })

  it('is its last completed sync while a run is left with more to read', () => {
    expect(
      trackerDataAsOf({ pending: true, lastSuccessAt: hoursAgo(30), dataAsOf: hoursAgo(1) }),
    ).toEqual(hoursAgo(30))
  })

  it('is the older of the connector data and the last completed sync otherwise', () => {
    expect(
      trackerDataAsOf({ pending: false, lastSuccessAt: hoursAgo(2), dataAsOf: hoursAgo(5) }),
    ).toEqual(hoursAgo(5))
    expect(
      trackerDataAsOf({ pending: false, lastSuccessAt: hoursAgo(5), dataAsOf: hoursAgo(2) }),
    ).toEqual(hoursAgo(5))
    expect(trackerDataAsOf({ pending: false, lastSuccessAt: hoursAgo(5), dataAsOf: null })).toEqual(
      hoursAgo(5),
    )
  })
})

describe('counts made by storage', () => {
  it('group as the work items would: sprint from the iteration path, values folded', () => {
    const ado = groupCountedRows(S, 'ado', [
      { state: 'Active', sprint: 'Apollo\\Sprint 1', count: 3 },
      { state: 'active', sprint: 'Apollo\\Sprint 2', count: 2 },
      { state: null, sprint: 'Apollo', count: 1 },
    ])
    expect(ado.total).toBe(6)
    expect(ado.byState.map((g) => [g.key, g.count])).toEqual([
      ['Active', 5],
      [null, 1],
    ])
    expect(ado.bySprint.map((g) => [g.key, g.count])).toEqual([
      ['Sprint 1', 3],
      ['Sprint 2', 2],
      [null, 1],
    ])
    const jira = groupCountedRows(S, 'jira', [{ state: 'Done', sprint: 'S4', count: 2 }])
    expect(jira.bySprint).toEqual([{ sourceId: S, key: 'S4', count: 2, storyPoints: null }])
  })
})
