import { describe, expect, it } from 'vitest'
import {
  RECIPE_ERROR_CODES,
  type RecipeErrorCode,
  recipeErrorText,
  validateRecipe,
} from '../src/recipe/index.ts'
import { sampleRecipe } from './support/recipes.ts'

type Raw = ReturnType<typeof sampleRecipe>

const codesOf = (input: unknown): RecipeErrorCode[] => {
  const v = validateRecipe(input)
  return v.ok ? [] : v.errors.map((e) => e.code)
}

const section = (r: Raw, id: string) => {
  const s = r.sections.find((x) => x.id === id)
  if (!s) throw new Error(id)
  return s
}
const block = (r: Raw, id: string) => {
  for (const s of r.sections) {
    const b = s.blocks.find((x) => x.id === id)
    if (b) return b as Record<string, unknown> & { columns: Array<Record<string, unknown>> }
  }
  throw new Error(id)
}
const check = (overrides: Record<string, unknown>) => ({
  id: 'extra_check',
  label: 'controllo di prova',
  message: 'Il controllo di prova non torna.',
  ...overrides,
})

describe('validateRecipe', () => {
  it('accepts the sample recipe', () => {
    const v = validateRecipe(sampleRecipe())
    expect(v.ok ? [] : v.errors).toEqual([])
  })

  it('rejects a recipe that loosens the freshness threshold', () => {
    const r = sampleRecipe()
    r.prerequisites[0] = {
      ...r.prerequisites[0],
      freshness: { warnAfterHours: 24, stopAfterHours: 168 },
    }
    expect(codesOf(r)).toEqual(['freshness_looser_than_default'])
  })

  it('rejects thresholds out of order or not whole hours', () => {
    const r = sampleRecipe()
    r.prerequisites[0] = {
      ...r.prerequisites[0],
      freshness: { warnAfterHours: 48, stopAfterHours: 24 },
    }
    expect(codesOf(r)).toEqual(['freshness_warn_after_stop'])
    r.prerequisites[0] = {
      ...r.prerequisites[0],
      freshness: { warnAfterHours: 0, stopAfterHours: 24 },
    }
    expect(codesOf(r)).toEqual(['freshness_invalid'])
  })

  it('rejects a freshness threshold on a source of documents', () => {
    const r = sampleRecipe()
    r.prerequisites[0] = {
      kind: 'source',
      sourceKinds: ['sharepoint'],
      level: 'required',
      freshness: { warnAfterHours: 12, stopAfterHours: 24 },
    }
    expect(codesOf(r)).toEqual(['freshness_on_document_source'])
  })

  it('rejects a column without a data category', () => {
    const r = sampleRecipe()
    delete block(r, 'positions').columns[2]?.category
    const v = validateRecipe(r)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.errors.map((e) => e.code)).toEqual(['column_without_category'])
    expect(recipeErrorText(v.errors[0] as never, 'it')).toContain('“Importo”')
  })

  it('rejects a computed value without a data category', () => {
    const r = sampleRecipe()
    delete block(r, 'order_total').category
    expect(codesOf(r)).toEqual(['value_without_category'])
  })

  it('rejects a column declared less restrictive than its source', () => {
    const r = sampleRecipe()
    // A labor cost of the warehouse declared as an invoiced amount would reach the client.
    const hours = block(r, 'hours')
    hours.columns.push({
      id: 'cost',
      title: 'Costo',
      from: { kind: 'field', field: 'laborcost_new' },
      category: 'invoiced_amounts',
    })
    const v = validateRecipe(r)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.errors.map((e) => e.code)).toEqual(['column_category_looser'])
    expect(recipeErrorText(v.errors[0] as never, 'it')).toContain('costi')
  })

  it('refuses a lateral move between contract and invoiced amounts', () => {
    const r = sampleRecipe()
    const amount = block(r, 'positions').columns[3] as Record<string, unknown>
    amount.category = 'contract_amounts'
    expect(codesOf(r)).toEqual(['column_category_looser'])
  })

  it('a declared category is never less restrictive than its source', () => {
    const r = sampleRecipe()
    // A field, a computed column and a sum, each declared below what it reads.
    ;(block(r, 'hours').columns[1] as Record<string, unknown>).category = 'other'
    ;(block(r, 'positions').columns[4] as Record<string, unknown>).category = 'other'
    block(r, 'order_total').category = 'other'
    expect(codesOf(r)).toEqual([
      'column_category_looser',
      'value_category_looser',
      'column_category_looser',
    ])
  })

  it('a value summed from a column raised to internal cannot be declared client', () => {
    const r = sampleRecipe()
    r.extraInternalCategories = [{ block: 'positions', column: 'amount', category: 'costs' }]
    // The total and the residual both read the raised column.
    expect(codesOf(r)).toEqual(['column_category_looser', 'value_category_looser'])
    block(r, 'order_total').category = 'costs'
    ;(block(r, 'positions').columns[4] as Record<string, unknown>).category = 'costs'
    expect(codesOf(r)).toEqual([])
  })

  it('lets a residual of ordered minus invoiced be declared as either amount, never as other', () => {
    const r = sampleRecipe()
    const residual = block(r, 'positions').columns[4] as Record<string, unknown>
    residual.category = 'invoiced_amounts'
    expect(codesOf(r)).toEqual([])
    residual.category = 'other'
    expect(codesOf(r)).toEqual(['column_category_looser'])
  })

  it('applies the same rule to computed values, by the effective category of each operand', () => {
    const r = sampleRecipe()
    section(r, 'order').blocks.push(
      {
        kind: 'data_value',
        id: 'invoiced_total',
        label: 'Totale fatturato',
        compute: { op: 'sum', column: { block: 'positions', column: 'invoiced' } },
        category: 'invoiced_amounts',
      },
      {
        kind: 'data_value',
        id: 'invoiced_share',
        label: 'Quota fatturata',
        compute: {
          op: 'ratio',
          left: { value: 'invoiced_total' },
          right: { value: 'order_total' },
        },
        category: 'invoiced_amounts',
      },
    )
    expect(codesOf(r)).toEqual([])
    block(r, 'invoiced_share').category = 'other'
    expect(codesOf(r)).toEqual(['value_category_looser'])
  })

  it('never lets an amount over a parameter, or minus project data, pass as project data', () => {
    const r = sampleRecipe()
    section(r, 'order').blocks.push({
      kind: 'data_value',
      id: 'per_request',
      label: 'Importo per richiesta',
      compute: {
        op: 'ratio',
        left: { value: 'order_total' },
        right: { parameter: 'request_number' },
      },
      category: 'other',
    })
    block(r, 'positions').columns[4] = {
      id: 'remaining',
      title: 'Residuo',
      from: { kind: 'difference', left: 'amount', right: 'line' },
      category: 'other',
    }
    expect(codesOf(r)).toEqual(['column_category_looser', 'value_category_looser'])
  })

  it('asks numeric checks and ratios for values that are numbers', () => {
    const r = sampleRecipe()
    section(r, 'order').blocks.push(
      {
        kind: 'data_value',
        id: 'note_value',
        label: 'Nota',
        compute: { op: 'parameter', parameter: 'note' },
        category: 'other',
      },
      {
        kind: 'data_value',
        id: 'odd_ratio',
        label: 'Rapporto',
        compute: { op: 'ratio', left: { value: 'note_value' }, right: { value: 'order_total' } },
        category: 'contract_amounts',
      },
    )
    r.checks.push(
      check({
        kind: 'sum_equals',
        column: { block: 'positions', column: 'amount' },
        equals: { value: 'note_value' },
      }),
    )
    expect(codesOf(r)).toEqual(['value_target_invalid', 'check_not_applicable'])
  })

  it('reads facts as the most restrictive category unless the query reads client facts', () => {
    const r = sampleRecipe()
    section(r, 'team').blocks.push({
      kind: 'data_list',
      id: 'notes',
      query: { kind: 'facts', factKind: 'note' },
      columns: [
        { id: 'v', title: 'Valore', from: { kind: 'field', field: 'value' }, category: 'other' },
      ],
    })
    expect(codesOf(r)).toEqual(['column_category_looser'])
  })

  it('lets a column be declared more restrictive than its source', () => {
    const r = sampleRecipe()
    const item = block(r, 'positions').columns[1] as Record<string, unknown>
    item.category = 'costs'
    expect(codesOf(r)).toEqual([])
  })

  it('treats a column the warehouse map does not know as the most restrictive', () => {
    const r = sampleRecipe()
    block(r, 'positions').columns.push({
      id: 'rep',
      title: 'Commerciale',
      from: { kind: 'field', field: 'salesrep' },
      category: 'other',
    })
    // `salesrep` is not a column the recipe may read at all.
    expect(codesOf(r)).toEqual(['column_field_unknown'])
  })

  it('rejects a check that points to a block it cannot apply to', () => {
    const r = sampleRecipe()
    r.checks.push(
      check({
        kind: 'bounded_text',
        slot: 'positions',
        forbiddenPhrases: [],
        connectorsWithoutData: true,
      }),
    )
    r.checks.push(
      check({
        id: 'sum_on_slot',
        kind: 'sum_equals',
        column: { block: 'summary_text', column: 'x' },
        equals: { value: 'order_total' },
      }),
    )
    expect(codesOf(r)).toEqual(['check_not_applicable', 'check_not_applicable'])
  })

  it('rejects a check whose target does not exist', () => {
    const r = sampleRecipe()
    r.checks.push(
      check({
        kind: 'unique',
        column: { block: 'positions', column: 'missing' },
        againstDeclared: true,
      }),
    )
    r.checks.push(check({ id: 'p', kind: 'present', block: 'nowhere' }))
    expect(codesOf(r)).toEqual(['check_target_unknown', 'check_target_unknown'])
  })

  it('accepts every check of the catalog on targets it applies to', () => {
    const r = sampleRecipe()
    r.checks.push(
      check({
        id: 'c1',
        kind: 'sum_at_most',
        column: { block: 'positions', column: 'invoiced' },
        atMost: { value: 'order_total' },
      }),
      check({
        id: 'c2',
        kind: 'difference_equals',
        block: 'positions',
        result: 'remaining',
        minuend: 'amount',
        subtrahend: 'invoiced',
      }),
      check({
        id: 'c3',
        kind: 'values_equal',
        left: { value: 'order_total' },
        right: { parameter: 'request_number' },
      }),
      check({ id: 'c4', kind: 'present', block: 'order_total' }),
      check({
        id: 'c5',
        kind: 'member_of',
        column: { block: 'positions', column: 'item' },
        in: { block: 'features', column: 'id' },
      }),
      check({
        id: 'c6',
        kind: 'count_consistent',
        block: 'features',
        count: { value: 'feature_count' },
      }),
      check({
        id: 'c7',
        kind: 'date_within_period',
        column: { block: 'positions', column: 'date' },
        period: 'period',
      }),
      check({
        id: 'c8',
        kind: 'unique',
        column: { block: 'positions', column: 'line' },
        againstDeclared: true,
      }),
      check({
        id: 'c9',
        kind: 'coverage',
        universe: { block: 'features', column: 'id' },
        coveredBy: [{ block: 'positions', column: 'item' }],
        allowUnassigned: true,
        exclusive: true,
      }),
      check({
        id: 'c10',
        kind: 'implies',
        block: 'features',
        condition: { column: 'state', in: ['Completato'] },
        consequence: { column: 'state', in: ['Chiuso', 'Completato'] },
      }),
      check({
        id: 'c11',
        kind: 'equals_previous',
        current: { block: 'positions', column: 'invoiced' },
        previous: { block: 'order_total' },
      }),
    )
    expect(codesOf(r)).toEqual([])
  })

  it('rejects misapplied checks of every shape', () => {
    const r = sampleRecipe()
    r.checks.push(
      check({
        id: 'c1',
        kind: 'count_consistent',
        block: 'order_total',
        count: { value: 'order_total' },
      }),
      check({
        id: 'c2',
        kind: 'date_within_period',
        column: { block: 'positions', column: 'date' },
        period: 'note',
      }),
      check({
        id: 'c3',
        kind: 'values_equal',
        left: { value: 'positions' },
        right: { parameter: 'missing' },
      }),
      check({ id: 'c4', kind: 'present', block: 'intro' }),
      check({
        id: 'c5',
        kind: 'equals_previous',
        current: { block: 'order_total', column: 'x' },
        previous: { block: 'positions' },
      }),
      check({
        id: 'c6',
        kind: 'implies',
        block: 'features',
        condition: { column: 'nope', in: ['a'] },
        consequence: { column: 'state', in: ['b'] },
      }),
      check({
        id: 'c7',
        kind: 'difference_equals',
        block: 'positions',
        result: 'x',
        minuend: 'amount',
        subtrahend: 'invoiced',
      }),
      check({
        id: 'c8',
        kind: 'bounded_text',
        slot: 'summary_text',
        forbiddenPhrases: [],
        connectorsWithoutData: false,
      }),
      check({
        id: 'c9',
        kind: 'sum_equals',
        column: { block: 'positions', column: 'amount' },
        equals: { parameter: 'note' },
      }),
      check({
        id: 'c10',
        kind: 'date_within_period',
        column: { block: 'positions', column: 'date' },
        period: 'missing',
      }),
    )
    expect(codesOf(r)).toEqual([
      'check_not_applicable',
      'check_not_applicable',
      'check_not_applicable',
      'check_target_unknown',
      'check_not_applicable',
      'check_not_applicable',
      'check_not_applicable',
      'check_target_unknown',
      'check_target_unknown',
      'check_without_constraint',
      'check_not_applicable',
      'check_target_unknown',
    ])
  })

  it('rejects a language other than Italian', () => {
    const r = sampleRecipe()
    r.lang = 'en'
    expect(codesOf(r)).toEqual(['lang_not_supported'])
  })

  it('rejects a sixth parameter asked at the same time', () => {
    const r = sampleRecipe()
    for (let i = 0; i < 4; i++) {
      r.parameters.push({
        id: `extra_${i}`,
        type: 'date',
        label: `Data ${i}`,
        required: false,
        step: 1,
      })
    }
    const v = validateRecipe(r)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.errors.map((e) => e.code)).toEqual(['parameters_too_many_at_once'])
    expect(recipeErrorText(v.errors[0] as never, 'it')).toBe(
      'Al passo 1 si chiedono 6 dati insieme: se ne possono chiedere al più 5 per volta.',
    )
  })

  it('accepts more than five parameters spread over steps', () => {
    const r = sampleRecipe()
    for (let i = 0; i < 3; i++) {
      r.parameters.push({
        id: `extra_${i}`,
        type: 'date',
        label: `Data ${i}`,
        required: false,
        step: 3,
      })
    }
    expect(codesOf(r)).toEqual([])
  })

  it('has no way to turn off a common gate', () => {
    const r = sampleRecipe()
    r.gates = { freshness: false }
    expect(codesOf(r)).toEqual(['recipe_unknown_field'])
    const s = sampleRecipe()
    s.checks.push(check({ kind: 'skip_gate', gate: 'audience' }))
    expect(codesOf(s)).toEqual(['recipe_malformed'])
    const c = sampleRecipe()
    ;(c.checks[0] as Record<string, unknown>).class = 'form'
    expect(codesOf(c)).toEqual(['recipe_unknown_field'])
  })

  it('accepts no free query', () => {
    const r = sampleRecipe()
    block(r, 'positions').query = { kind: 'sql', text: 'SELECT * FROM dwsi.v_invoice_all' }
    expect(codesOf(r)).toEqual(['recipe_malformed'])
    const v = sampleRecipe()
    block(v, 'positions').query = { kind: 'system_rows', view: 'base_invoice' }
    expect(codesOf(v)).toEqual(['system_view_unknown'])
    const w = sampleRecipe()
    block(w, 'positions').query = {
      kind: 'system_rows',
      view: 'v_sales_order_all',
      where: [{ column: 'salesrep', equals: { parameter: 'note' } }],
    }
    expect(codesOf(w)).toEqual(['system_column_unknown'])
  })

  it('rejects a format it does not know', () => {
    const r = sampleRecipe()
    r.schema = 'octobrief.recipe/2'
    expect(codesOf(r)).toEqual(['recipe_schema_unknown'])
    expect(codesOf('not a recipe')).toEqual(['recipe_malformed'])
  })

  it('rejects duplicated ids', () => {
    const r = sampleRecipe()
    r.sections.push({
      ...structuredClone(section(r, 'team')),
      blocks: [{ kind: 'static', id: 'intro', text: 'Altro testo.' }],
    })
    r.parameters.push({ id: 'period', type: 'date', label: 'Altra data', required: false, step: 2 })
    r.checks.push(structuredClone(r.checks[0] as Record<string, unknown>))
    block(r, 'hours').columns.push({
      id: 'employee',
      title: 'Persona',
      from: { kind: 'field', field: 'employee' },
      category: 'personal',
    })
    r.parameters.push({
      id: 'kind',
      type: 'choice',
      label: 'Tipo',
      required: false,
      step: 3,
      options: [
        { value: 'a', label: 'A' },
        { value: 'a', label: 'B' },
      ],
    })
    expect(codesOf(r).sort()).toEqual(
      [
        'block_duplicate',
        'check_duplicate',
        'column_duplicate',
        'option_duplicate',
        'parameter_duplicate',
        'section_duplicate',
      ].sort(),
    )
  })

  it('rejects references to parameters that do not exist or do not fit', () => {
    const r = sampleRecipe()
    section(r, 'summary').title = 'Sintesi di {{missing}}'
    const features = block(r, 'features')
    features.query = {
      kind: 'tracker',
      filter: {
        sprints: [{ parameter: 'period' }],
        dates: { field: 'closed', from: { parameter: 'note' } },
      },
    }
    expect(codesOf(r)).toEqual([
      'parameter_unknown',
      'parameter_wrong_type',
      'parameter_wrong_type',
    ])
  })

  describe('the recipients of a mail', () => {
    const withRecipients = () => {
      const r = sampleRecipe()
      r.parameters.push({
        id: 'recipients',
        type: 'text',
        label: 'Destinatari',
        required: false,
        step: 2,
        maxLength: 500,
      })
      return r
    }

    it('are a text parameter that the recipe may declare', () => {
      expect(codesOf(withRecipients())).toEqual([])
    })

    it('are never a title, a filter or a calculation: the addresses stay out of the model and the file', () => {
      const title = withRecipients()
      section(title, 'summary').title = 'Sintesi per {{recipients}}'
      expect(codesOf(title)).toEqual(['parameter_not_for_content'])

      const filter = withRecipients()
      block(filter, 'features').query = {
        kind: 'tracker',
        filter: { sprints: [{ parameter: 'recipients' }] },
      }
      expect(codesOf(filter)).toEqual(['parameter_not_for_content'])
    })

    it('are never compared, counted or used as a period in a check', () => {
      const compare = withRecipients()
      compare.checks.push(
        check({
          kind: 'values_equal',
          left: { parameter: 'recipients' },
          right: { parameter: 'recipients' },
        }),
      )
      expect(codesOf(compare)).toEqual(['parameter_not_for_content', 'parameter_not_for_content'])

      const period = withRecipients()
      period.checks.push(
        check({
          kind: 'date_within_period',
          column: { block: 'positions', column: 'date' },
          period: 'recipients',
        }),
      )
      expect(codesOf(period)).toEqual(['parameter_not_for_content'])
    })

    it('are not a number', () => {
      const r = withRecipients()
      r.parameters.pop()
      r.parameters.push({
        id: 'recipients',
        type: 'number',
        label: 'Destinatari',
        required: false,
        step: 2,
        integer: true,
      })
      expect(codesOf(r)).toContain('parameter_wrong_type')
    })
  })

  it('rejects a date filter with both a period and dates', () => {
    const r = sampleRecipe()
    block(r, 'features').query = {
      kind: 'tracker',
      filter: { dates: { field: 'closed', period: { parameter: 'period' }, from: '2026-01-01' } },
    }
    expect(codesOf(r)).toEqual(['query_dates_conflict'])
  })

  it('rejects a date filter on a date it also asks to be missing', () => {
    const r = sampleRecipe()
    block(r, 'features').query = {
      kind: 'tracker',
      filter: { dates: { field: 'created', from: '2026-01-01' }, undated: 'created' },
    }
    expect(codesOf(r)).toEqual(['query_dates_conflict'])
    block(r, 'features').query = {
      kind: 'tracker',
      filter: { dates: { field: 'changed', to: '2026-01-01' }, undated: 'created' },
    }
    expect(codesOf(r)).toEqual([])
  })

  it('keeps data out of titles and fixed texts', () => {
    const r = sampleRecipe()
    section(r, 'order').title = 'Posizioni al 31/10/2026'
    block(r, 'intro').text = 'Il totale è di 120.000 euro.'
    expect(codesOf(r)).toEqual(['title_with_data', 'static_with_data'])
  })

  it('shows in a title only a period, a choice or a number, never a free text', () => {
    const r = sampleRecipe()
    section(r, 'order').title = 'Posizioni {{ note }}'
    expect(codesOf(r)).toEqual(['title_parameter_not_allowed'])
    const ok = sampleRecipe()
    section(ok, 'order').title = 'Posizioni {{ sprint }} {{request_number}} {{period}}'
    expect(codesOf(ok)).toEqual([])
  })

  it('rejects contradictory sections', () => {
    const r = sampleRecipe()
    section(r, 'order').removable = true
    r.audience = 'internal'
    expect(codesOf(r)).toEqual(['section_required_and_removable', 'section_not_in_audience'])
    const c = sampleRecipe()
    c.audience = 'client'
    c.sections = [section(c, 'team')]
    c.checks = []
    c.render = { formats: ['md'], template: null, sections: [], namedCells: [] }
    expect(codesOf(c)).toEqual(['audience_without_sections'])
  })

  it('checks computed columns and values', () => {
    const r = sampleRecipe()
    const positions = block(r, 'positions')
    positions.columns.push({
      id: 'share',
      title: 'Quota',
      from: { kind: 'ratio', left: 'invoiced', right: 'ghost' },
      category: 'estimates',
    })
    positions.key = ['line', 'ghost']
    section(r, 'order').blocks.push(
      {
        kind: 'data_value',
        id: 'bad_count',
        label: 'Conteggio',
        compute: { op: 'count', block: 'order_total' },
        category: 'other',
      },
      {
        kind: 'data_value',
        id: 'bad_sum',
        label: 'Somma',
        compute: { op: 'sum', column: { block: 'positions', column: 'ghost' } },
        category: 'other',
      },
      {
        kind: 'data_value',
        id: 'loose',
        label: 'Totale dichiarato',
        compute: { op: 'max', column: { block: 'positions', column: 'amount' } },
        category: 'other',
      },
    )
    expect(codesOf(r)).toEqual([
      'column_operand_invalid',
      'key_column_unknown',
      'value_target_invalid',
      'value_target_invalid',
      'value_category_looser',
    ])
  })

  it('rejects a computed value that depends on itself', () => {
    const r = sampleRecipe()
    section(r, 'order').blocks.push(
      {
        kind: 'data_value',
        id: 'a',
        label: 'Primo',
        compute: { op: 'ratio', left: { value: 'b' }, right: { value: 'order_total' } },
        category: 'contract_amounts',
      },
      {
        kind: 'data_value',
        id: 'b',
        label: 'Secondo',
        compute: { op: 'difference', left: { value: 'a' }, right: { parameter: 'request_number' } },
        category: 'contract_amounts',
      },
      {
        kind: 'data_value',
        id: 'c',
        label: 'Terzo',
        compute: { op: 'parameter', parameter: 'request_number' },
        category: 'other',
      },
    )
    expect(codesOf(r)).toEqual(['value_cycle'])
  })

  it('reads the fields each kind of query gives', () => {
    const r = sampleRecipe()
    const team = section(r, 'team')
    team.blocks.push(
      {
        kind: 'data_list',
        id: 'risks',
        query: { kind: 'facts', factKind: 'risk', audience: 'client' },
        columns: [
          {
            id: 's',
            title: 'Rischio',
            from: { kind: 'field', field: 'statement' },
            category: 'other',
          },
        ],
      },
      {
        kind: 'data_list',
        id: 'docs',
        query: {
          kind: 'evidence',
          documentKinds: ['meeting_minutes'],
          audience: 'client',
          period: { parameter: 'period' },
        },
        columns: [
          { id: 't', title: 'Verbale', from: { kind: 'field', field: 'title' }, category: 'other' },
        ],
      },
      {
        kind: 'data_table',
        id: 'by_state',
        query: { kind: 'tracker', filter: {}, groupBy: 'assignee' },
        columns: [
          {
            id: 'k',
            title: 'Persona',
            from: { kind: 'field', field: 'key' },
            category: 'personal',
          },
          { id: 'n', title: 'Quanti', from: { kind: 'field', field: 'count' }, category: 'other' },
          { id: 'x', title: 'Altro', from: { kind: 'field', field: 'summary' }, category: 'other' },
        ],
      },
      {
        kind: 'data_list',
        id: 'note_value',
        query: { kind: 'parameter', parameter: 'note' },
        columns: [
          { id: 'v', title: 'Nota', from: { kind: 'field', field: 'value' }, category: 'other' },
        ],
      },
    )
    r.parameters.push(
      {
        id: 'items',
        type: 'work_item_selection',
        label: 'Elementi',
        required: false,
        step: 3,
        multiple: true,
      },
      {
        id: 'files',
        type: 'evidence_selection',
        label: 'Documenti',
        required: false,
        step: 3,
        multiple: true,
      },
    )
    team.blocks.push(
      {
        kind: 'data_list',
        id: 'picked',
        query: { kind: 'parameter', parameter: 'items' },
        columns: [
          {
            id: 'a',
            title: 'Assegnatario',
            from: { kind: 'field', field: 'assignee' },
            category: 'other',
          },
        ],
      },
      {
        kind: 'data_list',
        id: 'picked_files',
        query: { kind: 'parameter', parameter: 'files' },
        columns: [
          {
            id: 't',
            title: 'Documento',
            from: { kind: 'field', field: 'title' },
            category: 'personal',
          },
        ],
      },
    )
    // `summary` is not a field of grouped counts; an assignee is personal data.
    expect(codesOf(r)).toEqual(['column_field_unknown', 'column_category_looser'])
  })

  it('checks extra internal categories go only towards stricter ones', () => {
    const r = sampleRecipe()
    r.extraInternalCategories = [
      { block: 'positions', column: 'item', category: 'costs' },
      { block: 'order_total', category: 'margins' },
      { block: 'positions', column: 'amount', category: 'invoiced_amounts' },
      { block: 'positions', column: 'ghost', category: 'costs' },
      { block: 'positions', column: 'item', category: 'costs' },
    ]
    expect(codesOf(r)).toEqual([
      'extra_category_not_stricter',
      'extra_category_target_unknown',
      'extra_category_duplicate',
    ])
  })

  it('checks the render: text always, at most one file, mapping for that file only', () => {
    const r = sampleRecipe()
    r.render = {
      formats: ['docx', 'pptx', 'docx'],
      template: 'carta-intestata',
      sections: [
        { section: 'order', sheet: 'Foglio' },
        { section: 'ghost', style: 'Titolo' },
      ],
      namedCells: [
        { name: 'Totale', block: 'order_total' },
        { name: 'Totale', block: 'positions', column: 'amount' },
      ],
    }
    expect(codesOf(r)).toEqual([
      'render_without_md',
      'render_format_duplicate',
      'render_too_many_binary',
      'render_mapping_wrong_format',
      'render_section_unknown',
      'render_cell_invalid',
      'render_cell_duplicate',
      'render_cell_invalid',
    ])
    const t = sampleRecipe()
    t.render = { formats: ['md'], template: 'carta-intestata', sections: [], namedCells: [] }
    expect(codesOf(t)).toEqual(['render_template_without_binary'])
  })

  it('rejects a number parameter whose minimum exceeds its maximum', () => {
    const r = sampleRecipe()
    r.parameters.push({
      id: 'n',
      type: 'number',
      label: 'Quota',
      required: false,
      step: 3,
      integer: false,
      min: 5,
      max: 1,
    })
    expect(codesOf(r)).toEqual(['parameter_range_invalid'])
  })

  it('has an Italian text for every error code', () => {
    for (const code of RECIPE_ERROR_CODES) {
      const text = recipeErrorText(
        {
          code,
          params: {
            name: 'X',
            section: 'S',
            category: 'costs',
            step: 1,
            count: 6,
            max: 5,
            warn: 24,
            stop: 72,
          },
          path: '',
        },
        'it',
      )
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toMatch(/[{}]|_/)
    }
  })
})
