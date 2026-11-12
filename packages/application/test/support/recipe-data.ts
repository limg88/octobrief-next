// A synthetic project for the gathering of a recipe: an in-memory storage with a warehouse, a
// tracker, facts and evidence, and a recipe that reads them all. Every test changes a copy.

import {
  type FreshnessThresholds,
  newId,
  type ProjectId,
  type Recipe,
  type RecipeDataReader,
  type RecipeEvidenceView,
  type RecipeFactView,
  type RecipeSystemView,
  type SourceId,
  type StoredWorkItem,
  type TrackerSourceView,
  validateRecipe,
} from '@octobrief/domain/recipe'
import type { GatherDeps } from '../../src/index.ts'

export const PROJECT = newId<ProjectId>()
export const DWSI = newId<SourceId>()
export const ADO = newId<SourceId>()
export const NOW = new Date('2026-11-06T09:00:00.000Z')
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

export interface FakeStore {
  thresholds: FreshnessThresholds
  evidence: RecipeEvidenceView[]
  locators: Record<string, { kind: 'page'; page: number }>
  trackers: TrackerSourceView[]
  items: StoredWorkItem[]
  views: RecipeSystemView[]
  facts: RecipeFactView[]
  /** Every call to storage, by method. */
  calls: string[]
}

const evidence = (over: Partial<RecipeEvidenceView> & { id: string }): RecipeEvidenceView => ({
  title: 'Documento',
  sourceId: 'src-manual',
  sourceKind: 'manual_upload',
  contentHash: `sha256:${'0'.repeat(63)}1`,
  kind: 'contract',
  audience: 'internal',
  classificationVersion: 1,
  date: hoursAgo(24 * 10),
  dateSource: 'file_name',
  originSource: 'pm',
  policy: 'document',
  removedAt: null,
  ...over,
})

export function fakeStore(): FakeStore {
  return {
    thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
    evidence: [
      evidence({ id: 'ev-contract', title: 'Contratto quadro' }),
      evidence({
        id: 'ev-backlog',
        title: 'Export backlog.xlsx',
        kind: 'backlog_export',
        dateSource: 'acquisition',
        originSource: 'acquisition',
        policy: 'system',
        date: hoursAgo(5),
      }),
      evidence({
        id: 'ev-mail',
        title: 'Mail del fornitore',
        sourceId: 'src-mail',
        sourceKind: 'mail',
        kind: 'contract',
        removedAt: hoursAgo(1),
      }),
      evidence({ id: 'ev-dwsi', title: 'Estrazione DWSI ordini', kind: 'economics_export' }),
      evidence({ id: 'ev-minutes', title: 'Verbale del comitato', kind: 'meeting_minutes' }),
    ],
    locators: {
      'ev-contract': { kind: 'page', page: 1 },
      'ev-backlog': { kind: 'page', page: 1 },
      'ev-mail': { kind: 'page', page: 1 },
      'ev-minutes': { kind: 'page', page: 2 },
    },
    trackers: [
      {
        sourceId: ADO,
        kind: 'ado',
        label: 'Backlog Apollo',
        // The client's backlog, as the PM said on the Sources page.
        audience: 'client',
        dataAsOf: hoursAgo(2),
        pending: false,
        firstSuccessAt: hoursAgo(24 * 60),
        lastSuccessAt: hoursAgo(2),
        lastErrorAt: null,
        lastErrorCode: null,
      },
    ],
    items: [
      {
        sourceId: ADO,
        kind: 'ado',
        externalId: '101',
        url: null,
        fields: {
          title: 'Fatturazione elettronica',
          type: 'Feature',
          state: 'Closed',
          storyPoints: 8,
          closedAt: '2026-10-20T10:00:00.000Z',
          changedAt: '2026-10-20T10:00:00.000Z',
        },
      },
      {
        sourceId: ADO,
        kind: 'ado',
        externalId: '102',
        url: null,
        fields: {
          title: 'Portale clienti',
          type: 'Feature',
          state: 'Active',
          storyPoints: 5,
          changedAt: '2026-10-22T10:00:00.000Z',
        },
      },
    ],
    views: [
      {
        sourceId: DWSI,
        sourceLabel: 'Sistema amministrativo',
        scope: 'PRJ000123',
        view: 'v_sales_order_all',
        extractionId: 'x-1',
        evidenceId: 'ev-dwsi',
        evidenceTitle: 'Estrazione DWSI ordini',
        extractedAt: hoursAgo(3),
        sourceSyncedAt: hoursAgo(6),
        dataAsOf: hoursAgo(6),
        rows: [
          {
            key: 'SO-1|1',
            values: {
              projectid: 'PRJ000123',
              salesorderid: 'SO-1',
              lineid: 1,
              item: 'Analisi',
              amount: '12000.00',
              invoiced: '8000.00',
              status: 'Aperto',
              salesorderdate: '2026-09-01',
            },
          },
          {
            key: 'SO-1|2',
            values: {
              projectid: 'PRJ000123',
              salesorderid: 'SO-1',
              lineid: 2,
              item: 'Sviluppo',
              amount: '30000.50',
              invoiced: '0',
              status: 'Aperto',
              salesorderdate: '2026-09-01',
            },
          },
          {
            key: 'SO-0|1',
            values: {
              projectid: 'PRJ000123',
              salesorderid: 'SO-0',
              lineid: 1,
              item: 'Vecchio ordine',
              amount: '500',
              invoiced: '500',
              status: 'Chiuso',
              salesorderdate: '2026-01-10',
            },
          },
        ],
      },
    ],
    facts: [
      {
        id: 'fact-contract',
        kind: 'economics',
        key: 'economics:importo contratto',
        statement: "L'importo del contratto è 120.000 euro.",
        value: '120.000',
        state: 'contested',
        lockedByPm: false,
        pmAsserted: false,
        version: 2,
        date: hoursAgo(24 * 10),
        unknownAge: false,
        sources: [{ evidenceId: 'ev-contract', locator: { kind: 'page', page: 1 } }],
        candidates: [
          {
            statement: "L'importo del contratto è 125.000 euro.",
            value: '125.000',
            sources: [{ evidenceId: 'ev-minutes', locator: { kind: 'page', page: 2 } }],
          },
        ],
      },
      {
        id: 'fact-budget',
        kind: 'economics',
        key: 'economics:budget',
        statement: 'Il budget è 100.000 euro.',
        value: '100.000',
        state: 'active',
        lockedByPm: true,
        pmAsserted: false,
        version: 3,
        date: hoursAgo(24 * 2),
        unknownAge: false,
        sources: [{ evidenceId: 'ev-contract', locator: { kind: 'page', page: 1 } }],
        // A newer extraction says otherwise: the PM's correction wins.
        candidates: [
          {
            statement: 'Il budget è 120.000 euro.',
            value: '120.000',
            sources: [{ evidenceId: 'ev-minutes', locator: { kind: 'page', page: 2 } }],
          },
        ],
      },
      {
        id: 'fact-removed',
        kind: 'economics',
        key: 'economics:penale',
        statement: 'La penale è del 5%.',
        value: '5%',
        state: 'active',
        lockedByPm: false,
        pmAsserted: false,
        version: 1,
        date: hoursAgo(24 * 3),
        unknownAge: false,
        sources: [{ evidenceId: 'ev-mail', locator: { kind: 'page', page: 1 } }],
        candidates: [],
      },
    ],
    calls: [],
  }
}

/** The storage of the gathering over the in-memory project, recording every call. */
export function fakeReader(store: FakeStore): RecipeDataReader<'tx'> {
  const log = (name: string) => store.calls.push(name)
  return {
    async project() {
      log('project')
      return { thresholds: store.thresholds }
    },
    async evidence() {
      log('evidence')
      return structuredClone(store.evidence)
    },
    async firstLocators(_tx, _p, ids) {
      log('firstLocators')
      return new Map(ids.flatMap((id) => (store.locators[id] ? [[id, store.locators[id]]] : [])))
    },
    async trackerSources() {
      log('trackerSources')
      return structuredClone(store.trackers)
    },
    async trackerItems(_tx, _p, q) {
      log(`trackerItems@${q.at.toISOString()}`)
      return structuredClone(store.items.filter((i) => q.sourceIds.includes(i.sourceId)))
    },
    async systemViews(_tx, _p, view) {
      log(`systemViews:${view}`)
      return structuredClone(store.views.filter((v) => v.view === view))
    },
    async facts(_tx, _p, kind) {
      log(`facts:${kind}`)
      return structuredClone(store.facts.filter((f) => f.kind === kind))
    },
  }
}

export function deps(store: FakeStore, over: Partial<GatherDeps<'tx'>> = {}): GatherDeps<'tx'> {
  return {
    projectId: PROJECT,
    reader: fakeReader(store),
    withTx: (fn) => fn('tx'),
    now: NOW,
    recipeHash: `sha256:${'a'.repeat(64)}`,
    settingsHash: null,
    modelAlias: 'recipe-model',
    ...over,
  }
}

export function gatherRecipe(): Recipe {
  const v = validateRecipe({
    schema: 'octobrief.recipe/1',
    slug: 'stato-progetto',
    version: '1.0.0',
    title: 'Stato del progetto',
    purpose: 'Riassume ordini, avanzamento e conoscenza del progetto.',
    audience: 'internal',
    lang: 'it',
    parameters: [
      { id: 'period', type: 'period', label: 'Periodo', required: true, step: 1 },
      {
        id: 'chosen',
        type: 'evidence_selection',
        label: 'Documenti scelti',
        required: false,
        step: 1,
        multiple: true,
      },
    ],
    prerequisites: [{ kind: 'source', sourceKinds: ['netsuite_dwsi'], level: 'required' }],
    sections: [
      {
        id: 'order',
        title: 'Ordini aperti',
        required: true,
        version: 'internal',
        removable: false,
        blocks: [
          {
            kind: 'data_table',
            id: 'positions',
            title: 'Posizioni',
            query: {
              kind: 'system_rows',
              view: 'v_sales_order_all',
              where: [{ column: 'status', equals: 'aperto' }],
            },
            key: ['order', 'line'],
            columns: [
              {
                id: 'order',
                title: 'Ordine',
                from: { kind: 'field', field: 'salesorderid' },
                category: 'other',
              },
              {
                id: 'line',
                title: 'Riga',
                from: { kind: 'field', field: 'lineid' },
                category: 'other',
              },
              {
                id: 'amount',
                title: 'Importo',
                from: { kind: 'field', field: 'amount' },
                category: 'contract_amounts',
              },
              {
                id: 'invoiced',
                title: 'Fatturato',
                from: { kind: 'field', field: 'invoiced' },
                category: 'invoiced_amounts',
              },
              {
                id: 'date',
                title: 'Data',
                from: { kind: 'field', field: 'salesorderdate' },
                category: 'other',
              },
            ],
          },
          {
            kind: 'data_value',
            id: 'order_total',
            label: 'Totale ordinato',
            compute: { op: 'sum', column: { block: 'positions', column: 'amount' } },
            category: 'contract_amounts',
          },
        ],
      },
      {
        id: 'progress',
        title: 'Avanzamento {{period}}',
        required: true,
        version: 'internal',
        removable: false,
        blocks: [
          {
            kind: 'data_table',
            id: 'closed',
            title: 'Feature chiuse',
            query: {
              kind: 'tracker',
              filter: {
                types: ['Feature'],
                dates: { field: 'closed', period: { parameter: 'period' } },
              },
            },
            columns: [
              {
                id: 'id',
                title: 'Codice',
                from: { kind: 'field', field: 'id' },
                category: 'other',
              },
              {
                id: 'title',
                title: 'Titolo',
                from: { kind: 'field', field: 'summary' },
                category: 'other',
              },
              {
                id: 'points',
                title: 'Story point',
                from: { kind: 'field', field: 'story_points' },
                category: 'story_points',
              },
            ],
          },
          {
            kind: 'data_value',
            id: 'closed_count',
            label: 'Feature chiuse',
            compute: { op: 'count', block: 'closed' },
            category: 'other',
          },
        ],
      },
      {
        id: 'knowledge',
        title: 'Dati economici noti',
        required: false,
        version: 'internal',
        removable: true,
        blocks: [
          {
            kind: 'data_table',
            id: 'economics',
            title: 'Dati economici',
            query: { kind: 'facts', factKind: 'economics' },
            columns: [
              {
                id: 'statement',
                title: 'Dato',
                from: { kind: 'field', field: 'statement' },
                category: 'personal',
              },
              {
                id: 'value',
                title: 'Valore',
                from: { kind: 'field', field: 'value' },
                category: 'personal',
              },
            ],
          },
        ],
      },
      {
        id: 'documents',
        title: 'Documenti',
        required: false,
        version: 'internal',
        removable: true,
        blocks: [
          {
            kind: 'data_list',
            id: 'docs',
            title: 'Documenti di riferimento',
            query: { kind: 'evidence', documentKinds: ['contract', 'backlog_export'] },
            columns: [
              {
                id: 'title',
                title: 'Titolo',
                from: { kind: 'field', field: 'title' },
                category: 'personal',
              },
              {
                id: 'date',
                title: 'Data',
                from: { kind: 'field', field: 'date' },
                category: 'other',
              },
            ],
          },
          {
            kind: 'data_list',
            id: 'chosen_docs',
            title: 'Documenti scelti',
            query: { kind: 'parameter', parameter: 'chosen' },
            columns: [
              {
                id: 'title',
                title: 'Titolo',
                from: { kind: 'field', field: 'title' },
                category: 'personal',
              },
            ],
          },
        ],
      },
      {
        id: 'summary',
        title: 'Sintesi',
        required: true,
        version: 'internal',
        removable: false,
        blocks: [
          {
            kind: 'text_slot',
            id: 'summary_text',
            instructions: 'Riassumi lo stato del progetto.',
            natures: ['fact', 'inference'],
            maxChars: 1000,
          },
        ],
      },
    ],
    rules: [],
    checks: [],
    redTeamRules: [],
    extraInternalCategories: [],
    render: { formats: ['md'], template: null, sections: [], namedCells: [] },
    examples: [],
  })
  if (!v.ok) throw new Error(`invalid test recipe: ${JSON.stringify(v.errors)}`)
  return v.recipe
}

export const OCTOBER = { period: { type: 'period', from: '2026-10-01', to: '2026-10-31' } } as const
