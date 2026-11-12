// A synthetic recipe, valid as written: every test changes a copy of it.

export function sampleRecipe(): Record<string, unknown> & {
  sections: Array<Record<string, unknown> & { blocks: Array<Record<string, unknown>> }>
  parameters: Array<Record<string, unknown>>
  checks: Array<Record<string, unknown>>
  prerequisites: Array<Record<string, unknown>>
  render: Record<string, unknown>
} {
  return structuredClone({
    schema: 'octobrief.recipe/1',
    slug: 'sal-economico',
    version: '1.0.0',
    title: 'SAL economico',
    purpose: "Prepara la richiesta di SAL per l'amministrazione del cliente.",
    audience: 'both',
    lang: 'it',
    parameters: [
      { id: 'period', type: 'period', label: 'Periodo del SAL', required: true, step: 1 },
      {
        id: 'request_number',
        type: 'number',
        label: 'Numero della richiesta',
        required: true,
        step: 1,
        integer: true,
        min: 1,
      },
      {
        id: 'note',
        type: 'text',
        label: 'Nota per il cliente',
        required: false,
        step: 2,
        maxLength: 500,
      },
      {
        id: 'sprint',
        type: 'choice',
        label: 'Sprint',
        required: false,
        step: 2,
        options: [
          { value: 'current', label: 'Sprint corrente' },
          { value: 'previous', label: 'Sprint precedente' },
        ],
      },
    ],
    prerequisites: [
      {
        kind: 'source',
        sourceKinds: ['netsuite_dwsi'],
        level: 'required',
        freshness: { warnAfterHours: 12, stopAfterHours: 48 },
      },
      { kind: 'evidence', documentKinds: ['contract'], level: 'if_present' },
    ],
    sections: [
      {
        id: 'order',
        title: "Posizioni dell'ordine",
        required: true,
        version: 'both',
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
            key: ['line'],
            columns: [
              {
                id: 'line',
                title: 'Riga',
                from: { kind: 'field', field: 'lineid' },
                category: 'other',
              },
              // The text of the item of an order may carry rates (internal): the sample shows the
              // state of the line in its place.
              {
                id: 'item',
                title: 'Voce',
                from: { kind: 'field', field: 'status' },
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
                id: 'remaining',
                title: 'Residuo',
                from: { kind: 'difference', left: 'amount', right: 'invoiced' },
                category: 'contract_amounts',
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
            label: "Totale dell'ordine",
            compute: { op: 'sum', column: { block: 'positions', column: 'amount' } },
            category: 'contract_amounts',
          },
        ],
      },
      {
        id: 'summary',
        title: 'Sintesi del periodo {{period}}',
        required: true,
        version: 'both',
        removable: false,
        blocks: [
          { kind: 'static', id: 'intro', text: 'Di seguito lo stato della richiesta.' },
          {
            kind: 'text_slot',
            id: 'summary_text',
            instructions: 'Riassumi lo stato del periodo.',
            natures: ['fact', 'inference'],
            maxChars: 1200,
          },
        ],
      },
      {
        id: 'progress',
        title: 'Avanzamento',
        required: false,
        version: 'client',
        removable: true,
        blocks: [
          {
            kind: 'data_table',
            id: 'features',
            title: 'Feature',
            query: {
              kind: 'tracker',
              filter: {
                types: ['Feature'],
                sprints: [{ parameter: 'sprint' }],
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
                id: 'state',
                title: 'Stato',
                from: { kind: 'field', field: 'state' },
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
            id: 'feature_count',
            label: 'Feature chiuse',
            compute: { op: 'count', block: 'features' },
            category: 'other',
          },
        ],
      },
      {
        id: 'team',
        title: 'Consuntivo del team',
        required: false,
        version: 'internal',
        removable: true,
        blocks: [
          {
            kind: 'data_table',
            id: 'hours',
            title: 'Ore',
            query: { kind: 'system_rows', view: 'v_timesheet_all' },
            columns: [
              {
                id: 'employee',
                title: 'Persona',
                from: { kind: 'field', field: 'employee' },
                category: 'personal',
              },
              {
                id: 'duration',
                title: 'Ore lavorate',
                from: { kind: 'field', field: 'duration' },
                category: 'hours',
              },
            ],
          },
        ],
      },
    ],
    rules: ['Scrivi frasi brevi e concrete.'],
    checks: [
      {
        id: 'positions_sum',
        kind: 'sum_equals',
        label: 'somma delle posizioni',
        message: "La somma delle posizioni non corrisponde al totale dell'ordine.",
        column: { block: 'positions', column: 'amount' },
        equals: { value: 'order_total' },
      },
      {
        id: 'summary_length',
        kind: 'bounded_text',
        label: 'sintesi breve',
        message: 'La sintesi è troppo lunga o usa frasi da evitare.',
        slot: 'summary_text',
        maxChars: 800,
        forbiddenPhrases: ['nessun problema'],
        connectorsWithoutData: true,
      },
    ],
    redTeamRules: ['Nessun «nessun blocco» se ci sono blocchi attivi.'],
    extraInternalCategories: [],
    render: {
      formats: ['md', 'xlsx'],
      template: null,
      sections: [{ section: 'order', sheet: 'Posizioni' }],
      namedCells: [{ name: 'TotaleOrdine', block: 'order_total' }],
    },
    examples: [
      { title: 'SAL di un progetto sintetico', summary: 'Una richiesta con tre posizioni.' },
    ],
  })
}
