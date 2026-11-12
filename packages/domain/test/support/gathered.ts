// What a run of the sample recipe gathered, written by hand: every test of the skeleton changes a
// copy of it. Synthetic data only.

import type {
  DocumentSourceRef,
  GatheredData,
  GatheredNote,
  GatheredRow,
} from '../../src/recipe/index.ts'

export const REFERENCE_TIME = '2026-11-06T09:30:00.000Z'
export const DWSI_AS_OF = '2026-11-05T22:00:00.000Z'
export const TRACKER_AS_OF = '2026-11-06T06:00:00.000Z'

export const orderRef = (line: string): DocumentSourceRef => ({
  kind: 'system_row',
  sourceId: 'src-dwsi',
  view: 'v_sales_order_all',
  key: [
    { column: 'salesorderid', value: 'SO-4711' },
    { column: 'lineid', value: line },
  ],
})

/** A line of the order as the positions of the sample recipe cite it: with the columns they read. */
export const orderNoteRef = (line: string): DocumentSourceRef =>
  ({
    ...orderRef(line),
    columns: ['amount', 'invoiced', 'lineid', 'salesorderdate', 'status'],
  }) as DocumentSourceRef

export const hoursRef = (id: string): DocumentSourceRef => ({
  kind: 'system_row',
  sourceId: 'src-dwsi',
  view: 'v_timesheet_all',
  key: [{ column: 'internalid', value: id }],
})

export const itemRef = (id: string): DocumentSourceRef => ({
  kind: 'work_item',
  sourceId: 'src-ado',
  id,
})

export const COUNTS_REF: DocumentSourceRef = {
  kind: 'work_item_counts',
  sourceId: 'src-ado',
  query: 'features',
}

const ORDER_FIELDS = ['lineid', 'item', 'amount', 'invoiced', 'salesorderdate', 'status']

function orderRow(line: string, item: string, amount: number, invoiced: number): GatheredRow {
  const ref = orderRef(line)
  return {
    values: {
      lineid: line,
      item,
      amount,
      invoiced,
      salesorderdate: { day: '2026-10-01' },
      status: 'aperto',
    },
    refs: Object.fromEntries(ORDER_FIELDS.map((f) => [f, ref])),
  }
}

function featureRow(id: string, state: string, points: number | null): GatheredRow {
  const ref = itemRef(id)
  return {
    values: { id, state, story_points: points },
    refs: { id: ref, state: ref, story_points: ref },
  }
}

function hoursRow(id: string, employee: string, duration: number): GatheredRow {
  const ref = hoursRef(id)
  return { values: { employee, duration }, refs: { employee: ref, duration: ref } }
}

const note = (ref: DocumentSourceRef, label: string, dataAsOf: string | null): GatheredNote => ({
  ref,
  label,
  dataAsOf,
})

export function sampleGathered(): GatheredData {
  return structuredClone({
    recipe: { slug: 'sal-economico', version: '1.0.0' },
    lang: 'it',
    referenceTime: REFERENCE_TIME,
    parameters: {
      period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
      request_number: { type: 'number', value: 3 },
    },
    parameterTexts: { period: 'ottobre 2026', request_number: '3' },
    periods: { period: { from: '2026-10-01', to: '2026-10-31' } },
    blocks: {
      positions: {
        status: 'read',
        rows: [
          orderRow('1', 'Analisi funzionale', 12000, 8000),
          orderRow('2', 'Sviluppo', 30500.5, 10000),
        ],
        totals: [],
      },
      features: {
        status: 'read',
        rows: [featureRow('F-12', 'Chiusa', 8), featureRow('F-15', 'Chiusa', 5)],
        totals: [COUNTS_REF],
      },
      hours: {
        status: 'read',
        rows: [hoursRow('9', 'Persona Uno', 120)],
        totals: [],
      },
    },
    notes: [
      note(orderRef('1'), 'Ordini (DWSI) SO-4711, riga 1', DWSI_AS_OF),
      note(orderRef('2'), 'Ordini (DWSI) SO-4711, riga 2', DWSI_AS_OF),
      note(itemRef('F-12'), 'Backlog ADO, elemento F-12', TRACKER_AS_OF),
      note(itemRef('F-15'), 'Backlog ADO, elemento F-15', TRACKER_AS_OF),
      note(COUNTS_REF, 'Backlog ADO, conteggi', TRACKER_AS_OF),
      note(hoursRef('9'), 'Ore (DWSI), riga 9', DWSI_AS_OF),
      note({ kind: 'parameter', parameterId: 'period' }, 'Indicato da te: Periodo del SAL', null),
      note(
        { kind: 'parameter', parameterId: 'request_number' },
        'Indicato da te: Numero della richiesta',
        null,
      ),
    ],
    readLog: [],
    freshness: [],
    contradictions: [],
    contestedFacts: [],
    removedEvidence: [],
    context: {
      evidence: {},
      facts: {},
      freshness: {
        now: REFERENCE_TIME,
        thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
        sourceKinds: { 'src-dwsi': 'netsuite_dwsi', 'src-ado': 'ado' },
        evidence: {},
        facts: {},
      },
      trackers: { 'src-ado': 'client' },
    },
  }) as GatheredData
}
