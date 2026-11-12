import { describe, expect, it } from 'vitest'
import {
  type AudienceContext,
  buildSkeleton,
  checkAudience,
  clientPolicy,
  type DocumentCell,
  type DocumentSkeleton,
  type DocumentSourceRef,
  DomainError,
  documentSchema,
  type GatheredData,
  type InternalDocument,
  MAX_CELL_SOURCES,
  mergeDocument,
  projectClientVersion,
  rowKeysOf,
  runRedTeam,
  skeletonForWriter,
  skeletonHash,
  skeletonSchema,
  valueTraces,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'
import {
  COUNTS_REF,
  orderNoteRef,
  orderRef,
  REFERENCE_TIME,
  sampleGathered,
} from './support/gathered.ts'
import { sampleRecipe } from './support/recipes.ts'

type Section = DocumentSkeleton['sections'][number]
type Block = Section['blocks'][number]

const sectionOf = (s: DocumentSkeleton, id: string) =>
  s.sections.find((x) => x.id === id) as Section
const blockOf = (s: DocumentSkeleton, id: string): Block => {
  for (const section of s.sections) {
    const b = section.blocks.find((x) => x.id === id)
    if (b) return b
  }
  throw new Error(`no block ${id}`)
}
const tableOf = (s: DocumentSkeleton, id: string) =>
  blockOf(s, id) as Extract<Block, { kind: 'table' }>
const valueCell = (s: DocumentSkeleton, id: string) =>
  (blockOf(s, id) as Extract<Block, { kind: 'value' }>).cell
const noteRefs = (s: DocumentSkeleton, cell: DocumentCell) =>
  cell.sources.map((n) => {
    const note = s.sourceNotes.find((x) => x.n === n)
    return note && 'ref' in note ? note.ref : null
  })

function skeletonOf(gathered: GatheredData = sampleGathered(), raw = sampleRecipe()) {
  return buildSkeleton(recipeOf(raw), gathered)
}

function clientContext(gathered: GatheredData): AudienceContext {
  return {
    recipe: recipeOf(),
    policy: clientPolicy(),
    evidence: gathered.context.evidence,
    facts: gathered.context.facts,
    parameters: gathered.parameterTexts,
    ...(gathered.context.trackers ? { trackers: gathered.context.trackers } : {}),
  }
}

/** A recipe that counts 26 contracts, the one at `internalAt` internal, and what it gathered. */
function counting(internalAt: number | null) {
  const recipe = recipeOf({
    ...sampleRecipe(),
    slug: 'conteggio',
    parameters: [],
    prerequisites: [],
    checks: [],
    render: { formats: ['md'], template: null, sections: [], namedCells: [] },
    sections: [
      {
        id: 'docs',
        title: 'Documenti',
        required: true,
        version: 'internal',
        removable: false,
        blocks: [
          {
            kind: 'data_list',
            id: 'list',
            title: 'Elenco',
            query: { kind: 'evidence', documentKinds: ['contract'] },
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
        id: 'kpi',
        title: 'Numeri',
        required: true,
        version: 'both',
        removable: false,
        blocks: [
          {
            kind: 'data_value',
            id: 'how_many',
            label: 'Documenti contrattuali',
            compute: { op: 'count', block: 'list' },
            category: 'other',
          },
        ],
      },
    ],
  })
  const gathered = sampleGathered()
  gathered.recipe = { slug: 'conteggio', version: '1.0.0' }
  const evidence: Record<string, GatheredData['context']['evidence'][string]> = {}
  const rows = Array.from({ length: 26 }, (_, i) => {
    const id = `ev-${i + 1}`
    evidence[id] = {
      kind: 'contract',
      audience: i === internalAt ? 'internal' : 'client',
      fromSystem: false,
      title: `Contratto ${i + 1}`,
    }
    const ref = { kind: 'evidence', evidenceId: id, locator: { kind: 'page', page: 1 } } as const
    return { values: { title: `Contratto ${i + 1}` }, refs: { title: ref } }
  })
  gathered.blocks = { list: { status: 'read', rows, totals: [] } }
  gathered.notes = rows.map((r) => ({ ref: r.refs.title, label: 'Contratto', dataAsOf: null }))
  gathered.context = { ...gathered.context, evidence }
  return { recipe, gathered, rows }
}

/**
 * A count for the client of 25 work items the PM selected, listed in an internal section: the
 * 24th of an internal tracker, beyond the 20 notes the cell of the count cites.
 */
function selectedCount() {
  const recipe = recipeOf({
    ...sampleRecipe(),
    slug: 'conteggio',
    parameters: [
      {
        id: 'chosen',
        type: 'work_item_selection',
        label: 'Elementi scelti',
        required: true,
        step: 1,
        multiple: true,
      },
    ],
    prerequisites: [],
    checks: [],
    render: { formats: ['md'], template: null, sections: [], namedCells: [] },
    sections: [
      {
        id: 'items',
        title: 'Elementi',
        required: true,
        version: 'internal',
        removable: false,
        blocks: [
          {
            kind: 'data_list',
            id: 'list',
            title: 'Elenco',
            query: { kind: 'parameter', parameter: 'chosen' },
            columns: [
              {
                id: 'id',
                title: 'Elemento',
                from: { kind: 'field', field: 'id' },
                category: 'other',
              },
            ],
          },
        ],
      },
      {
        id: 'kpi',
        title: 'Numeri',
        required: true,
        version: 'both',
        removable: false,
        blocks: [
          {
            kind: 'data_value',
            id: 'how_many',
            label: 'Elementi',
            compute: { op: 'count', block: 'list' },
            category: 'other',
          },
        ],
      },
    ],
  })
  const gathered = sampleGathered()
  gathered.recipe = { slug: 'conteggio', version: '1.0.0' }
  const rows = Array.from({ length: 25 }, (_, i) => {
    // The 24th comes from the internal backlog.
    const sourceId = i === 23 ? 'src-jira' : 'src-ado'
    const ref = { kind: 'work_item', sourceId, id: `US-${i + 1}` } as const
    return { values: { id: `US-${i + 1}` }, refs: { id: ref } }
  })
  gathered.parameters = {
    chosen: {
      type: 'work_item_selection',
      items: rows.map((r) => ({ sourceId: r.refs.id.sourceId, id: r.refs.id.id })),
    },
  }
  gathered.blocks = { list: { status: 'read', rows, totals: [] } }
  gathered.notes = rows.map((r) => ({ ref: r.refs.id, label: 'Elemento', dataAsOf: null }))
  gathered.context = {
    ...gathered.context,
    trackers: { 'src-ado': 'client', 'src-jira': 'internal' },
  }
  return { recipe, gathered }
}

describe('recipe skeleton', () => {
  it('builds the same skeleton hash from the same input snapshot', () => {
    const a = skeletonOf()
    const b = skeletonOf()
    expect(a.skeletonHash).toBe(b.skeletonHash)
    expect(a.skeletonHash).toBe(skeletonHash(a.skeleton))
    expect(a.skeleton).toEqual(b.skeleton)

    const changed = sampleGathered()
    const positions = changed.blocks.positions as Extract<
      GatheredData['blocks'][string],
      { status: 'read' }
    >
    ;(positions.rows[0] as { values: Record<string, unknown> }).values.amount = 12001
    expect(skeletonOf(changed).skeletonHash).not.toBe(a.skeletonHash)
  })

  it('is a valid internal skeleton with every section of the recipe in its order', () => {
    const { skeleton } = skeletonOf()
    expect(skeletonSchema.safeParse(skeleton).success).toBe(true)
    expect(skeleton.audience).toBe('internal')
    expect(skeleton.sections.map((s) => s.id)).toEqual(['order', 'summary', 'progress', 'team'])
    expect(skeleton.header).toEqual({
      dataAsOf: '2026-11-05T22:00:00.000Z',
      generatedAt: REFERENCE_TIME,
    })
    expect(skeleton.recipe).toEqual({
      slug: 'sal-economico',
      version: '1.0.0',
      title: 'SAL economico',
    })
  })

  it('fills the titles of the recipe with the values of the parameters', () => {
    const { skeleton } = skeletonOf()
    expect(skeleton.title).toBe('SAL economico')
    expect(sectionOf(skeleton, 'summary').title).toBe('Sintesi del periodo ottobre 2026')
    const noPeriod = sampleGathered()
    noPeriod.parameterTexts = {}
    expect(sectionOf(skeletonOf(noPeriod).skeleton, 'summary').title).toBe(
      'Sintesi del periodo non dedotto',
    )
  })

  it('writes numbers, amounts and days in the Italian way', () => {
    const { skeleton } = skeletonOf()
    const [first, second] = tableOf(skeleton, 'positions').rows
    expect(first?.cells.map((c) => c.text)).toEqual([
      '1',
      'aperto',
      '12.000,00',
      '8.000,00',
      '4.000,00',
      '01/10/2026',
    ])
    expect(second?.cells[2]?.text).toBe('30.500,50')
    expect(valueCell(skeleton, 'order_total').text).toBe('42.500,50')
  })

  it('gives every cell and value the categories the client gate recomputes', () => {
    const { skeleton } = skeletonOf()
    const positions = tableOf(skeleton, 'positions')
    expect(positions.columns.map((c) => c.category)).toEqual([
      'other',
      'other',
      'contract_amounts',
      'invoiced_amounts',
      'contract_amounts',
      'other',
    ])
    const remaining = positions.rows[0]?.cells[4] as DocumentCell
    expect(remaining.operandCategories).toEqual(['contract_amounts', 'invoiced_amounts'])
    expect(remaining.category).toBe('contract_amounts')
    expect(valueCell(skeleton, 'order_total').operandCategories).toEqual(['contract_amounts'])
    expect(valueCell(skeleton, 'feature_count').operandCategories).toEqual(['other'])
  })

  it('raises a column with the more restrictive labels of the recipe', () => {
    const raw = sampleRecipe()
    raw.extraInternalCategories = [{ block: 'features', column: 'points', category: 'estimates' }]
    const { skeleton } = skeletonOf(sampleGathered(), raw)
    const features = tableOf(skeleton, 'features')
    expect(features.columns[2]?.category).toBe('estimates')
    expect(features.rows[0]?.cells[2]?.operandCategories).toEqual(['estimates'])
  })

  it('keys every row with its key cells, and rows that share a key by position', () => {
    const { skeleton } = skeletonOf()
    const positions = tableOf(skeleton, 'positions')
    expect(positions.rows.map((r) => r.key)).toEqual(['["1"]', '["2"]'])
    const recipe = recipeOf()
    const rb = recipe.sections[0]?.blocks[0]
    if (rb?.kind !== 'data_table') throw new Error('positions')
    expect(
      rowKeysOf(
        rb,
        positions.columns.map((c) => c.id),
        positions.rows.map((r) => r.cells),
      ),
    ).toEqual(positions.rows.map((r) => r.key))

    const same = sampleGathered()
    const read = same.blocks.positions as Extract<
      GatheredData['blocks'][string],
      { status: 'read' }
    >
    ;(read.rows[1] as { values: Record<string, unknown> }).values.lineid = '1'
    expect(tableOf(skeletonOf(same).skeleton, 'positions').rows.map((r) => r.key)).toEqual([
      '1',
      '2',
    ])
    // Without a key in the recipe, rows go by position.
    expect(tableOf(skeletonOf().skeleton, 'hours').rows.map((r) => r.key)).toEqual(['1'])
  })

  it('cites in a value only the sources its computation reads', () => {
    const { skeleton } = skeletonOf()
    expect(noteRefs(skeleton, valueCell(skeleton, 'order_total'))).toEqual([
      orderNoteRef('1'),
      orderNoteRef('2'),
    ])
    // A tracker counts its work items itself: the count cites its counts.
    expect(noteRefs(skeleton, valueCell(skeleton, 'feature_count'))).toEqual([COUNTS_REF])
    expect(valueCell(skeleton, 'feature_count').text).toBe('2')
  })

  it('numbers each place once, in the order it is first cited', () => {
    const { skeleton } = skeletonOf()
    expect(skeleton.sourceNotes.map((n) => n.n)).toEqual(skeleton.sourceNotes.map((_, i) => i + 1))
    const positions = tableOf(skeleton, 'positions')
    expect(positions.rows[0]?.cells.every((c) => c.sources.join() === '1')).toBe(true)
    expect(positions.rows[1]?.cells.every((c) => c.sources.join() === '2')).toBe(true)
  })

  it('marks a section not deduced when a mandatory parameter was skipped', () => {
    const gathered = sampleGathered()
    gathered.parameters = { request_number: { type: 'number', value: 3 } }
    gathered.parameterTexts = { request_number: '3' }
    const { skeleton } = skeletonOf(gathered)
    expect(sectionOf(skeleton, 'summary').notDeduced).toBe(true)
    expect(sectionOf(skeleton, 'progress').notDeduced).toBe(true)
    expect(sectionOf(skeleton, 'order').notDeduced).toBe(false)
    const features = tableOf(skeleton, 'features')
    expect(features.notDeduced).toBe(true)
    expect(features.rows).toEqual([])
    expect(valueCell(skeleton, 'feature_count')).toMatchObject({ text: null, sources: [] })
    // The places of a section left out are never cited.
    expect(skeleton.sourceNotes.some((n) => n.ref.kind === 'work_item')).toBe(false)
  })

  it('leaves a block not deduced when its source could not be read', () => {
    const gathered = sampleGathered()
    gathered.blocks = {
      ...gathered.blocks,
      features: { status: 'not_deduced', reason: 'no_source' },
    }
    const { skeleton } = skeletonOf(gathered)
    expect(tableOf(skeleton, 'features').notDeduced).toBe(true)
    expect(valueCell(skeleton, 'feature_count').text).toBeNull()
  })

  it('shows «non dedotto», never a number, for a figure without a source', () => {
    const gathered = sampleGathered()
    const positions = gathered.blocks.positions as Extract<
      GatheredData['blocks'][string],
      { status: 'read' }
    >
    const row = positions.rows[1] as {
      values: Record<string, unknown>
      refs: Record<string, unknown>
    }
    row.values.amount = null
    delete row.refs.status
    const { skeleton } = skeletonOf(gathered)
    const cells = tableOf(skeleton, 'positions').rows[1]?.cells as DocumentCell[]
    expect(cells[1]).toMatchObject({ text: null, sources: [] })
    expect(cells[2]).toMatchObject({ text: null, sources: [] })
    // A difference with a missing operand, and a total over a missing value.
    expect(cells[4]?.text).toBeNull()
    expect(valueCell(skeleton, 'order_total')).toMatchObject({ text: null, sources: [] })

    const empty = sampleGathered()
    empty.blocks = { ...empty.blocks, positions: { status: 'read', rows: [], totals: [] } }
    expect(valueCell(skeletonOf(empty).skeleton, 'order_total').text).toBeNull()
  })

  it('shows the values the PM gave as «indicato da te», and the lowest and highest amount', () => {
    const raw = sampleRecipe()
    const order = raw.sections[0] as { blocks: Array<Record<string, unknown>> }
    const value = (id: string, compute: Record<string, unknown>, category = 'other') => ({
      kind: 'data_value',
      id,
      label: `Valore ${id}`,
      compute,
      category,
    })
    raw.parameters.push({
      id: 'cutoff',
      type: 'date',
      label: 'Data limite',
      required: false,
      step: 3,
    })
    order.blocks.push(
      value('note_value', { op: 'parameter', parameter: 'note' }),
      value('period_value', { op: 'parameter', parameter: 'period' }),
      value('sprint_value', { op: 'parameter', parameter: 'sprint' }),
      value('cutoff_value', { op: 'parameter', parameter: 'cutoff' }),
      value(
        'lowest',
        { op: 'min', column: { block: 'positions', column: 'amount' } },
        'contract_amounts',
      ),
      value(
        'highest',
        { op: 'max', column: { block: 'positions', column: 'amount' } },
        'contract_amounts',
      ),
      value(
        'gap',
        { op: 'difference', left: { value: 'highest' }, right: { value: 'lowest' } },
        'contract_amounts',
      ),
      {
        kind: 'data_list',
        id: 'note_list',
        title: 'Nota',
        query: { kind: 'parameter', parameter: 'note' },
        columns: [
          {
            id: 'text',
            title: 'Testo',
            from: { kind: 'field', field: 'value' },
            category: 'other',
          },
        ],
      },
    )
    const gathered = sampleGathered()
    gathered.parameters = {
      ...gathered.parameters,
      note: { type: 'text', value: 'Consegna puntuale' },
      sprint: { type: 'choice', value: 'current' },
      cutoff: { type: 'date', day: '2026-10-20' },
    }
    const pm = (id: string) => ({ kind: 'parameter', parameterId: id }) as const
    gathered.notes = [
      ...gathered.notes,
      ...['note', 'sprint', 'cutoff'].map((id) => ({ ref: pm(id), label: id, dataAsOf: null })),
    ]
    gathered.blocks = {
      ...gathered.blocks,
      note_list: {
        status: 'read',
        rows: [{ values: { value: 'Consegna puntuale' }, refs: { value: pm('note') } }],
        totals: [],
      },
    }
    const { skeleton } = skeletonOf(gathered, raw)
    expect(valueCell(skeleton, 'note_value').text).toBe('Consegna puntuale')
    expect(valueCell(skeleton, 'period_value').text).toBe('ottobre 2026')
    expect(valueCell(skeleton, 'sprint_value').text).toBe('Sprint corrente')
    expect(valueCell(skeleton, 'cutoff_value').text).toBe('20/10/2026')
    expect(valueCell(skeleton, 'lowest').text).toBe('12.000,00')
    expect(valueCell(skeleton, 'highest').text).toBe('30.500,50')
    expect(valueCell(skeleton, 'gap').text).toBe('18.500,50')
    expect(noteRefs(skeleton, valueCell(skeleton, 'cutoff_value'))).toEqual([pm('cutoff')])
    const list = blockOf(skeleton, 'note_list') as Extract<Block, { kind: 'list' }>
    expect(list.items[0]?.cells[0]?.text).toBe('Consegna puntuale')
    // A parameter skipped is «non dedotto».
    delete (gathered.parameters as Record<string, unknown>).cutoff
    expect(valueCell(skeletonOf(gathered, raw).skeleton, 'cutoff_value').text).toBeNull()
  })

  it('computes ratios as percentages and values from parameters', () => {
    const raw = sampleRecipe()
    const order = raw.sections[0] as { blocks: Array<Record<string, unknown>> }
    order.blocks.push(
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
      {
        kind: 'data_value',
        id: 'request',
        label: 'Richiesta',
        compute: { op: 'parameter', parameter: 'request_number' },
        category: 'other',
      },
    )
    const { skeleton } = skeletonOf(sampleGathered(), raw)
    const share = valueCell(skeleton, 'invoiced_share')
    expect(share.text).toBe('42,4%')
    expect(share.operandCategories).toEqual(['invoiced_amounts', 'contract_amounts'])
    expect(noteRefs(skeleton, share)).toEqual([orderNoteRef('1'), orderNoteRef('2')])
    const request = valueCell(skeleton, 'request')
    expect(request.text).toBe('3')
    expect(noteRefs(skeleton, request)).toEqual([
      { kind: 'parameter', parameterId: 'request_number' },
    ])
  })

  it('cites at most as many notes as a cell admits', () => {
    const gathered = sampleGathered()
    const rows = Array.from({ length: MAX_CELL_SOURCES + 5 }, (_, i) => {
      const ref = orderRef(String(i + 1))
      return {
        values: { lineid: String(i + 1), item: 'Voce', amount: 10, invoiced: 0 },
        refs: { lineid: ref, item: ref, amount: ref, invoiced: ref },
      }
    })
    gathered.blocks = { ...gathered.blocks, positions: { status: 'read', rows, totals: [] } }
    gathered.notes = [
      ...gathered.notes,
      ...rows.map((r) => ({ ref: r.refs.lineid, label: 'Riga', dataAsOf: null })),
    ]
    const { skeleton } = skeletonOf(gathered)
    expect(valueCell(skeleton, 'order_total').sources).toHaveLength(MAX_CELL_SOURCES)
    expect(valueCell(skeleton, 'order_total').text).toBe('250,00')
  })

  it('refuses gathered data of another recipe or a place without its note', () => {
    const other = sampleGathered()
    other.recipe = { slug: 'sal-economico', version: '2.0.0' }
    expect(() => skeletonOf(other)).toThrow(DomainError)
    const noNote = sampleGathered()
    noNote.notes = noNote.notes.slice(1)
    expect(() => skeletonOf(noNote)).toThrow(/skeleton_note_unknown/)
  })

  it('keeps the text slots for the writer, with their titles and limits', () => {
    const { skeleton } = skeletonOf()
    expect(blockOf(skeleton, 'summary_text')).toEqual({
      kind: 'slot',
      id: 'summary_text',
      natures: ['fact', 'inference'],
      maxChars: 1200,
    })
    expect(blockOf(skeleton, 'intro')).toEqual({
      kind: 'static',
      id: 'intro',
      text: 'Di seguito lo stato della richiesta.',
    })
  })

  it('lets the rows of a selection of the PM cite what was selected, for the client too', () => {
    const raw = sampleRecipe()
    raw.parameters.push({
      id: 'chosen',
      type: 'work_item_selection',
      label: 'Elementi scelti',
      required: false,
      step: 3,
      multiple: true,
    })
    ;(raw.sections[0] as { blocks: Array<Record<string, unknown>> }).blocks.push({
      kind: 'data_list',
      id: 'chosen_items',
      title: 'Elementi scelti',
      query: { kind: 'parameter', parameter: 'chosen' },
      columns: [
        { id: 'code', title: 'Codice', from: { kind: 'field', field: 'id' }, category: 'other' },
      ],
    })
    const gathered = sampleGathered()
    const ref = { kind: 'work_item', sourceId: 'src-ado', id: 'F-12' } as const
    gathered.parameters = {
      ...gathered.parameters,
      chosen: { type: 'work_item_selection', items: [{ sourceId: 'src-ado', id: 'F-12' }] },
    }
    gathered.blocks = {
      ...gathered.blocks,
      chosen_items: {
        status: 'read',
        rows: [{ values: { id: 'F-12' }, refs: { id: ref } }],
        totals: [],
      },
    }
    const recipe = recipeOf(raw)
    const { skeleton } = buildSkeleton(recipe, gathered)
    const internal = mergeDocument(skeleton, {})
    const ctx = { ...clientContext(gathered), recipe }
    const { version } = projectClientVersion(internal, ctx)
    const list = version.document.sections[0]?.blocks.find((b) => b.id === 'chosen_items')
    expect(list?.kind === 'list' && list.items[0]?.cells[0]?.text).toBe('F-12')
  })

  it('gives the red-team a draft it checks without structure anomalies, contradictions shown', () => {
    const gathered = sampleGathered()
    gathered.contradictions = [
      {
        key: 'fact:fact-contract',
        subject: 'Le fonti danno valori diversi su un dato di tipo «dati economici»',
        sides: [
          { value: '120.000', source: { kind: 'fact', factId: 'fact-contract' } },
          { value: '125.000', source: orderRef('1') },
        ],
      },
    ]
    const recipe = recipeOf()
    const internal = mergeDocument(skeletonOf(gathered).skeleton, {})
    if (internal.audience !== 'internal') throw new Error('internal')
    const result = runRedTeam(internal, {
      recipe,
      client: { audience: clientContext(gathered) },
      lang: 'it',
      parameters: gathered.parameterTexts,
      periods: gathered.periods,
      knownNames: [],
      freshness: gathered.context.freshness,
      contestedFacts: gathered.contestedFacts,
      contradictions: gathered.contradictions,
      declaredValues: [],
      slotVerifications: {},
      acceptances: [],
      decisions: [],
      suspicious: {},
    })
    const open = result.anomalies.filter((a) => a.status === 'open')
    expect(open.filter((a) => a.class === 'structure')).toEqual([])
    expect(open.map((a) => a.code)).toContain('contradiction_open')
    // The sum of the positions is the total of the order: the check of the recipe holds.
    expect(open.some((a) => a.ref.element === 'check' && a.ref.check === 'positions_sum')).toBe(
      false,
    )
  })

  it('adds up a column as its cells show it, and never shows a negative zero', () => {
    const gathered = sampleGathered()
    const positions = gathered.blocks.positions as Extract<
      GatheredData['blocks'][string],
      { status: 'read' }
    >
    const [a, b] = positions.rows as unknown as Array<{ values: Record<string, unknown> }>
    ;(a as { values: Record<string, unknown> }).values.amount = 1.004
    ;(b as { values: Record<string, unknown> }).values.amount = 2.004
    ;(a as { values: Record<string, unknown> }).values.invoiced = -0
    const { skeleton } = skeletonOf(gathered)
    const rows = tableOf(skeleton, 'positions').rows
    expect(rows.map((r) => r.cells[2]?.text)).toEqual(['1,00', '2,00'])
    expect(rows[0]?.cells[3]?.text).toBe('0,00')
    expect(valueCell(skeleton, 'order_total').text).toBe('3,00')
  })

  it('leaves the date of the data «non dedotto» when a source it cites does not date it', () => {
    const gathered = sampleGathered()
    gathered.notes = gathered.notes.map((n) =>
      n.ref.kind === 'work_item' ? { ...n, dataAsOf: null } : n,
    )
    expect(skeletonOf(gathered).skeleton.header.dataAsOf).toBeNull()
  })

  it('withholds a count whose last counted row takes from an internal source, beyond the cited notes', () => {
    const { recipe, gathered, rows } = counting(25)
    const { skeleton } = buildSkeleton(recipe, gathered)
    const count = valueCell(skeleton, 'how_many')
    expect(count.text).toBe('26')
    expect(count.sources).toHaveLength(MAX_CELL_SOURCES)
    const { version, report } = projectClientVersion(mergeDocument(skeleton, {}), {
      ...clientContext(gathered),
      recipe,
    })
    const kpi = version.document.sections.find((s) => s.id === 'kpi')
    expect(kpi?.blocks).toEqual([])
    expect(report.anomalies.map((a) => [a.code, a.ref, a.internalSource])).toEqual([
      ['internal_data_in_client', { element: 'value', section: 'kpi', block: 'how_many' }, true],
    ])
    // A counted row without a place to cite: the count has no source, «non dedotto».
    ;(rows[3] as { refs: Record<string, unknown> }).refs = {}
    expect(valueCell(buildSkeleton(recipe, gathered).skeleton, 'how_many').text).toBeNull()
  })

  it('a client count of 25 selected items, one of an internal tracker beyond the cited, is an anomaly', () => {
    const { recipe, gathered } = selectedCount()
    const { skeleton } = buildSkeleton(recipe, gathered)
    const count = valueCell(skeleton, 'how_many')
    expect(count.text).toBe('25')
    // The internal item is not among the notes the cell cites.
    const cited = new Set(count.sources)
    const internalNote = skeleton.sourceNotes.find(
      (n) => n.ref.kind === 'work_item' && n.ref.sourceId === 'src-jira',
    )
    expect(internalNote && cited.has(internalNote.n)).toBe(false)
    const { report } = projectClientVersion(mergeDocument(skeleton, {}), {
      ...clientContext(gathered),
      recipe,
    })
    expect(report.anomalies.map((a) => [a.code, a.ref, a.internalSource])).toEqual([
      ['internal_data_in_client', { element: 'value', section: 'kpi', block: 'how_many' }, true],
    ])
  })

  it('a value over more than 20 items, an internal one beyond the cited, is hidden from a client slot writer', () => {
    const { recipe, gathered } = selectedCount()
    const { skeleton } = buildSkeleton(recipe, gathered)
    const internal = (ref: DocumentSourceRef) =>
      ref.kind === 'work_item' && ref.sourceId === 'src-jira'
    const countShown = (context: unknown) =>
      (
        context as {
          sezioni: Array<{ blocchi: Array<{ id: string; valore?: { testo: unknown } }> }>
        }
      ).sezioni
        .flatMap((x) => x.blocchi)
        .find((b) => b.id === 'how_many')?.valore?.testo
    // By the notes of its cell alone the count would show.
    expect(countShown(skeletonForWriter(skeleton, 'it', { ref: internal }).context)).toBe('25')
    const valueReads = new Map(
      valueTraces(mergeDocument(skeleton, {}) as InternalDocument, recipe).map((t) => [
        t.block,
        { refs: t.refs, complete: t.complete },
      ]),
    )
    expect(
      countShown(skeletonForWriter(skeleton, 'it', { ref: internal, valueReads }).context),
    ).toBeNull()
  })

  it('hidden notes are not counted among the notes not shown', () => {
    const { recipe, gathered } = selectedCount()
    const { skeleton } = buildSkeleton(recipe, gathered)
    const notShown = (context: unknown) =>
      (context as { note_non_mostrate: number }).note_non_mostrate
    // All 25 work items hidden: the writer cannot tell how many there were.
    const workItem = (ref: DocumentSourceRef) => ref.kind === 'work_item'
    expect(skeleton.sourceNotes.filter((n) => workItem(n.ref))).toHaveLength(25)
    expect(notShown(skeletonForWriter(skeleton, 'it', { ref: workItem }).context)).toBe(
      notShown(skeletonForWriter(skeleton, 'it').context),
    )
  })

  it('a value whose trace is incomplete is hidden from the client slot writer', () => {
    // Only items of the client: by its places the count would show.
    const { recipe, gathered } = selectedCount()
    gathered.context = {
      ...gathered.context,
      trackers: { 'src-ado': 'client', 'src-jira': 'client' },
    }
    const { skeleton } = buildSkeleton(recipe, gathered)
    const internal = (ref: DocumentSourceRef) =>
      ref.kind === 'work_item' && ref.sourceId !== 'src-ado' && ref.sourceId !== 'src-jira'
    const shownCount = (context: unknown) =>
      (
        context as {
          sezioni: Array<{ blocchi: Array<{ id: string; valore?: { testo: unknown } }> }>
        }
      ).sezioni
        .flatMap((x) => x.blocchi)
        .find((b) => b.id === 'how_many')?.valore?.testo
    const traces = (doc: InternalDocument) =>
      new Map(
        valueTraces(doc, recipe).map((t) => [t.block, { refs: t.refs, complete: t.complete }]),
      )
    const doc = mergeDocument(skeleton, {}) as InternalDocument
    expect(
      shownCount(
        skeletonForWriter(skeleton, 'it', { ref: internal, valueReads: traces(doc) }).context,
      ),
    ).toBe('25')
    // A counted row that lost its places: what the count reads is not known, so it is hidden.
    const list = doc.sections.flatMap((x) => x.blocks).find((b) => b.id === 'list')
    if (list?.kind !== 'list' || !list.items[0]) throw new Error('list')
    for (const c of list.items[0].cells) c.sources = []
    const incomplete = traces(doc)
    expect(incomplete.get('how_many')?.complete).toBe(false)
    expect(
      shownCount(
        skeletonForWriter(skeleton, 'it', { ref: internal, valueReads: incomplete }).context,
      ),
    ).toBeNull()
  })

  it('a client slot writer never sees text written from an internal tracker', () => {
    const { recipe, gathered } = selectedCount()
    const { skeleton } = buildSkeleton(recipe, gathered)
    const hiddenNote = skeleton.sourceNotes.find(
      (n) => n.ref.kind === 'work_item' && n.ref.sourceId === 'src-jira',
    )
    if (!hiddenNote) throw new Error('no internal note')
    // A revision: another slot already written, one segment from the internal item.
    const kpi = skeleton.sections.find((x) => x.id === 'kpi')
    kpi?.blocks.push({
      kind: 'text',
      id: 'other_text',
      notDeduced: false,
      segments: [
        {
          text: 'La stima riservata del fornitore è chiusa.',
          nature: 'fact',
          category: 'other',
          sources: [hiddenNote.n],
          sourceCategories: ['other'],
        },
      ],
    } as never)
    const internal = (ref: DocumentSourceRef) =>
      ref.kind === 'work_item' && ref.sourceId === 'src-jira'
    const shown = JSON.stringify(skeletonForWriter(skeleton, 'it', { ref: internal }).context)
    expect(shown).not.toContain('stima riservata')
    expect(JSON.stringify(skeletonForWriter(skeleton, 'it').context)).toContain('stima riservata')
  })

  it('recomputes what a value reads, refusing a trace tampered, cut or missing', () => {
    const { recipe, gathered } = counting(25)
    const internal = mergeDocument(buildSkeleton(recipe, gathered).skeleton, {})
    const ctx = { ...clientContext(gathered), recipe }
    const { version } = projectClientVersion(internal, ctx)
    // The re-check of the version as projected (the count withheld) agrees.
    expect(checkAudience(version, ctx, internal).anomalies).toEqual([])
    const cut = {
      ...version,
      values: version.values.map((v) => ({ ...v, refs: v.refs.slice(0, 20) })),
    }
    const marked = {
      ...version,
      values: version.values.map((v) => ({ ...v, complete: true, refs: [] })),
    }
    const missing = { ...version, values: [] }
    const absent = { document: version.document, notes: version.notes } as unknown as typeof version
    for (const forged of [cut, marked, missing, absent]) {
      try {
        checkAudience(forged, ctx, internal)
        throw new Error('accepted')
      } catch (e) {
        expect((e as DomainError).code).toBe('client_version_inconsistent')
      }
    }
  })

  it('judges a value reading a row that cites no place as taking from an internal source', () => {
    const { recipe, gathered } = counting(null)
    const internal = mergeDocument(buildSkeleton(recipe, gathered).skeleton, {})
    const ctx = { ...clientContext(gathered), recipe }
    expect(projectClientVersion(internal, ctx).report.anomalies).toEqual([])
    // A document whose counted row lost its places: the trace is incomplete, fail closed.
    const list = internal.sections[0]?.blocks[0]
    if (list?.kind !== 'list' || !list.items[0]) throw new Error('list')
    for (const c of list.items[0].cells) c.sources = []
    const { report } = projectClientVersion(internal, ctx)
    expect(report.anomalies.map((a) => [a.code, a.internalSource])).toEqual([
      ['internal_data_in_client', true],
    ])
  })

  it('makes a skeleton the client version can be projected from', () => {
    const gathered = sampleGathered()
    const { skeleton } = skeletonOf(gathered)
    const internal = mergeDocument(skeleton, {})
    expect(documentSchema.safeParse(internal).success).toBe(true)
    const { version, report } = projectClientVersion(internal, clientContext(gathered))
    expect(version.document.sections.map((s) => s.id)).toEqual(['order', 'summary', 'progress'])
    // Contract and invoiced amounts reach the client; the story points only with their warning.
    expect(report.anomalies).toEqual([])
    expect(report.warnings.map((w) => w.code)).toEqual(['story_points_in_client'])
  })
})
