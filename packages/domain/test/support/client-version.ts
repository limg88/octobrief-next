// A synthetic internal document built from the sample recipe, and the context of the client
// gate around it: every test of the client version changes a copy of them.

import {
  type AudienceContext,
  clientPolicy,
  type DeliverableDocument,
  type Recipe,
  validateRecipe,
} from '../../src/recipe/index.ts'
import { sampleRecipe } from './recipes.ts'

export const AS_OF = '2026-11-05T07:00:00.000Z'
export const DWSI_TITLE = 'Estrazione economica DWSI ottobre'
export const INTERNAL_NOTE = 'Il cliente non sa ancora del ritardo sul modulo di fatturazione.'

export function recipeOf(raw: Record<string, unknown> = sampleRecipe()): Recipe {
  const v = validateRecipe(raw)
  if (!v.ok) throw new Error(`invalid test recipe: ${JSON.stringify(v.errors)}`)
  return v.recipe
}

const cell = (
  text: string | null,
  category: string,
  operandCategories: string[],
  sources: number[] = [1],
) => ({ text, category, operandCategories, sources })

export function internalDocument(): Extract<DeliverableDocument, { audience: 'internal' }> {
  return structuredClone({
    schema: 'octobrief.document/1',
    recipe: { slug: 'sal-economico', version: '1.0.0', title: 'SAL economico' },
    audience: 'internal',
    lang: 'it',
    title: 'SAL economico',
    header: { dataAsOf: AS_OF, generatedAt: '2026-11-06T09:30:00.000Z' },
    sections: [
      {
        id: 'order',
        title: "Posizioni dell'ordine",
        version: 'both',
        notDeduced: false,
        blocks: [
          {
            kind: 'table',
            id: 'positions',
            title: 'Posizioni',
            notDeduced: false,
            columns: [
              { id: 'line', title: 'Riga', category: 'other' },
              { id: 'item', title: 'Voce', category: 'other' },
              { id: 'amount', title: 'Importo', category: 'contract_amounts' },
              { id: 'invoiced', title: 'Fatturato', category: 'invoiced_amounts' },
              { id: 'remaining', title: 'Residuo', category: 'contract_amounts' },
              { id: 'date', title: 'Data', category: 'other' },
            ],
            rows: [
              {
                key: '1',
                cells: [
                  cell('1', 'other', ['other']),
                  cell('Analisi funzionale', 'other', ['other']),
                  cell('12.000,00 €', 'contract_amounts', ['contract_amounts']),
                  cell('8.000,00 €', 'invoiced_amounts', ['invoiced_amounts']),
                  cell('4.000,00 €', 'contract_amounts', ['contract_amounts', 'invoiced_amounts']),
                  cell('01/10/2026', 'other', ['other']),
                ],
              },
            ],
          },
          {
            kind: 'value',
            id: 'order_total',
            label: "Totale dell'ordine",
            cell: cell('12.000,00 €', 'contract_amounts', ['contract_amounts']),
          },
        ],
      },
      {
        id: 'summary',
        title: 'Sintesi del periodo ottobre 2026',
        version: 'both',
        notDeduced: false,
        blocks: [
          { kind: 'static', id: 'intro', text: 'Di seguito lo stato della richiesta.' },
          {
            kind: 'text',
            id: 'summary_text',
            notDeduced: false,
            segments: [
              {
                text: "Fatturati 8.000,00 € sui 12.000,00 € dell'ordine.",
                nature: 'fact',
                category: 'contract_amounts',
                sources: [1, 1],
                sourceCategories: ['invoiced_amounts', 'contract_amounts'],
              },
              {
                text: 'Il progetto chiude il mese al 18% sul venduto.',
                nature: 'fact',
                category: 'margins',
                sources: [3],
                sourceCategories: ['margins'],
              },
              {
                text: 'La consegna resta prevista per fine novembre.',
                nature: 'inference',
                category: 'other',
                sources: [],
                sourceCategories: [],
              },
            ],
          },
        ],
      },
      {
        id: 'progress',
        title: 'Avanzamento',
        version: 'client',
        notDeduced: false,
        blocks: [
          {
            kind: 'table',
            id: 'features',
            title: 'Feature',
            notDeduced: false,
            columns: [
              { id: 'id', title: 'Codice', category: 'other' },
              { id: 'state', title: 'Stato', category: 'other' },
              { id: 'points', title: 'Story point', category: 'story_points' },
            ],
            rows: [
              {
                key: 'F-12',
                cells: [
                  cell('F-12', 'other', ['other'], [2]),
                  cell('Chiusa', 'other', ['other'], [2]),
                  cell('8', 'story_points', ['story_points'], [2]),
                ],
              },
            ],
          },
          {
            kind: 'value',
            id: 'feature_count',
            label: 'Feature chiuse',
            cell: cell('1', 'other', ['other'], [2]),
          },
        ],
      },
      {
        id: 'team',
        title: 'Consuntivo del team',
        version: 'internal',
        notDeduced: false,
        blocks: [
          {
            kind: 'table',
            id: 'hours',
            title: 'Ore',
            notDeduced: false,
            columns: [
              { id: 'employee', title: 'Persona', category: 'personal' },
              { id: 'duration', title: 'Ore lavorate', category: 'hours' },
            ],
            rows: [
              {
                key: 'r1',
                cells: [
                  cell('Persona 1', 'personal', ['personal'], [4]),
                  cell('120', 'hours', ['hours'], [4]),
                ],
              },
            ],
          },
        ],
      },
    ],
    sourceNotes: [
      {
        n: 1,
        label: 'Ordine 4711, riga 1',
        dataAsOf: AS_OF,
        ref: {
          kind: 'system_row',
          sourceId: 'dwsi',
          view: 'v_sales_order_all',
          key: [
            { column: 'salesorderid', value: '4711' },
            { column: 'lineid', value: '1' },
          ],
          // The columns the positions read: the ordered and invoiced amounts, never the item.
          columns: ['amount', 'invoiced', 'lineid', 'salesorderdate', 'status'],
        },
      },
      {
        n: 2,
        label: 'Feature F-12 «Fatturazione elettronica»',
        dataAsOf: '2026-11-06T06:00:00.000Z',
        ref: { kind: 'work_item', sourceId: 'ado', id: 'F-12' },
      },
      {
        n: 3,
        label: DWSI_TITLE,
        dataAsOf: AS_OF,
        ref: { kind: 'evidence', evidenceId: 'ev-dwsi', locator: { kind: 'page', page: 1 } },
      },
      {
        n: 4,
        label: 'Timesheet di ottobre',
        dataAsOf: AS_OF,
        ref: {
          kind: 'system_row',
          sourceId: 'dwsi',
          view: 'v_timesheet_all',
          key: [{ column: 'internalid', value: '9' }],
        },
      },
    ],
    internalNotes: [
      {
        text: INTERNAL_NOTE,
        nature: 'inference',
        category: 'other',
        sources: [],
        sourceCategories: [],
      },
    ],
  }) as Extract<DeliverableDocument, { audience: 'internal' }>
}

export function audienceContext(recipe: Recipe = recipeOf()): AudienceContext {
  return {
    recipe,
    policy: clientPolicy(),
    evidence: {
      'ev-dwsi': {
        kind: 'economics_export',
        audience: 'internal',
        fromSystem: true,
        title: DWSI_TITLE,
      },
      'ev-minutes': {
        kind: 'meeting_minutes',
        audience: 'client',
        fromSystem: false,
        title: 'Verbale del comitato di ottobre',
      },
    },
    parameters: { period: 'ottobre 2026', request_number: '3' },
    facts: {
      'fact-risk': { kind: 'risk', clientOnly: true },
      'fact-margin': { kind: 'economics', clientOnly: true },
    },
    // The client's backlog: the PM said so on the Sources page.
    trackers: { ado: 'client' },
  }
}
