import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  blockRemarkWarnings,
  buildSkeleton,
  canonicalJson,
  clientPolicy,
  type DocumentSkeleton,
  type DocumentSourceRef,
  DomainError,
  type GatheredData,
  type InternalDocument,
  inputSnapshotHash,
  MAX_BLOCK_ROWS,
  mergeDocument,
  type ParameterValues,
  projectClientVersion,
  type Recipe,
  type RecipeEvidenceView,
  redTeamFindingText,
  runCommonGates,
  type SourceId,
  type TrackerSourceView,
  validateRecipe,
} from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { gatherRecipeData } from '../src/index.ts'
import {
  ADO,
  DWSI,
  deps,
  type FakeStore,
  fakeStore,
  gatherRecipe,
  hoursAgo,
  NOW,
  OCTOBER,
} from './support/recipe-data.ts'

const recipe = gatherRecipe()

/**
 * The recipe in a run for the client: the tracker section reaches the client version, unless
 * `internalSection`, which stays in the internal one.
 */
function forClientRun(internalSection = false) {
  return {
    ...recipe,
    audience: 'both' as const,
    sections: recipe.sections.map((s) =>
      s.blocks.some((b) => b.id === 'closed')
        ? { ...s, version: internalSection ? ('internal' as const) : ('both' as const) }
        : s,
    ),
  }
}

/** The fake store with an internal backlog beside the client's, one item matching the block. */
function withInternalBacklog() {
  const store = fakeStore()
  const jira = 'src-jira' as SourceId
  store.trackers.push({
    ...(store.trackers[0] as TrackerSourceView),
    sourceId: jira,
    kind: 'jira',
    label: 'Backlog interno',
    audience: 'internal',
  })
  store.items.push({
    sourceId: jira,
    kind: 'jira',
    externalId: 'INT-7',
    url: null,
    fields: {
      title: 'Stima interna',
      type: 'Feature',
      status: 'Done',
      resolvedAt: '2026-10-21T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
    },
  })
  return { store, jira }
}

async function gather(store: FakeStore = fakeStore(), values: ParameterValues = OCTOBER) {
  return gatherRecipeData(recipe, values, deps(store))
}

const rowsOf = (g: GatheredData, block: string) => {
  const b = g.blocks[block]
  if (b?.status !== 'read') throw new Error(`block ${block} not read`)
  return b.rows
}

type Block = DocumentSkeleton['sections'][number]['blocks'][number]
const blockOf = (s: DocumentSkeleton, id: string) =>
  s.sections.flatMap((x) => x.blocks).find((b) => b.id === id) as Block

describe('gathering the data of a recipe', () => {
  it('builds the same skeleton hash from the same input snapshot', async () => {
    const a = await gather()
    const b = await gather()
    expect(inputSnapshotHash(a.snapshot)).toBe(inputSnapshotHash(b.snapshot))
    expect(buildSkeleton(recipe, a.gathered).skeletonHash).toBe(
      buildSkeleton(recipe, b.gathered).skeletonHash,
    )

    // A row of the warehouse with another value is another snapshot, and another skeleton.
    const store = fakeStore()
    const row = store.views[0]?.rows[0] as { values: Record<string, unknown> }
    row.values.amount = '12500.00'
    const c = await gather(store)
    expect(inputSnapshotHash(c.snapshot)).not.toBe(inputSnapshotHash(a.snapshot))
    expect(buildSkeleton(recipe, c.gathered).skeletonHash).not.toBe(
      buildSkeleton(recipe, a.gathered).skeletonHash,
    )
  })

  it('records the system rows read in the snapshot', async () => {
    const { snapshot, gathered } = await gather()
    expect(snapshot.systemRows).toEqual([
      expect.objectContaining({
        sourceId: DWSI,
        scope: 'PRJ000123',
        view: 'v_sales_order_all',
        extractionId: 'x-1',
        rowKey: 'SO-1|1',
        values: expect.objectContaining({ amount: '12000.00', status: 'Aperto' }),
        dataAsOf: hoursAgo(6).toISOString(),
        extractedAt: hoursAgo(3).toISOString(),
        sourceSyncedAt: hoursAgo(6).toISOString(),
      }),
      expect.objectContaining({ rowKey: 'SO-1|2' }),
    ])
    // The closed order is filtered out by the recipe: never read into the run.
    expect(rowsOf(gathered, 'positions')).toHaveLength(2)
    expect(snapshot).toMatchObject({
      referenceTime: NOW.toISOString(),
      recipe: { slug: 'stato-progetto', version: '1.0.0' },
      modelAlias: 'recipe-model',
      parameters: OCTOBER,
      policies: {
        freshness: { warnAfterHours: 24, stopAfterHours: 72 },
        clientCategories: ['contract_amounts', 'invoiced_amounts', 'other'],
      },
      tracker: [{ sourceId: ADO, at: NOW.toISOString(), dataAsOf: hoursAgo(2).toISOString() }],
    })
    expect(snapshot.facts.map((f) => [f.id, f.version])).toEqual([
      ['fact-budget', 3],
      ['fact-contract', 2],
    ])
  })

  it('dates the warehouse twice, and leaves undated data «non dedotto» without a date', async () => {
    const { gathered } = await gather()
    expect(gathered.freshness.find((f) => f.source === `system:${DWSI}`)).toEqual({
      source: `system:${DWSI}`,
      policy: 'system',
      level: 'fresh',
      dataAsOf: hoursAgo(6).toISOString(),
      extractedAt: hoursAgo(3).toISOString(),
      sourceSyncedAt: hoursAgo(6).toISOString(),
    })
    const store = fakeStore()
    const view = store.views[0] as { dataAsOf: Date | null; sourceSyncedAt: Date | null }
    view.dataAsOf = null
    view.sourceSyncedAt = null
    const undated = (await gather(store)).gathered
    expect(undated.freshness.find((f) => f.source === `system:${DWSI}`)?.level).toBe('unknown')
    const notes = undated.notes.filter((n) => n.ref.kind === 'system_row')
    expect(notes.every((n) => n.dataAsOf === null)).toBe(true)
  })

  it('reads the tracker as of the reference time, filtered by the recipe and the period', async () => {
    const store = fakeStore()
    const { gathered } = await gather(store)
    expect(store.calls).toContain(`trackerItems@${NOW.toISOString()}`)
    const rows = rowsOf(gathered, 'closed')
    expect(rows.map((r) => r.values.id)).toEqual(['101'])
    expect(rows[0]?.values.closed).toEqual({ day: '2026-10-20' })
    const skeleton = buildSkeleton(recipe, gathered).skeleton
    const count = blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>
    expect(count.cell.text).toBe('1')
    expect(skeleton.sourceNotes.find((n) => count.cell.sources.includes(n.n))?.ref).toEqual({
      kind: 'work_item_counts',
      sourceId: ADO,
      query: 'closed',
    })
  })

  it('a client document never counts items from an internal tracker', async () => {
    const { store, jira } = withInternalBacklog()
    const forClient = forClientRun()
    const { gathered, snapshot } = await gatherRecipeData(forClient, OCTOBER, deps(store))
    expect(rowsOf(gathered, 'closed').map((r) => r.values.id)).toEqual(['101'])
    const closed = gathered.blocks.closed
    expect(closed?.status === 'read' && closed.remarks).toEqual([
      { code: 'internal_source_left_out', source: 'Backlog interno' },
    ])
    const { skeleton } = buildSkeleton(forClient, gathered)
    const count = blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>
    expect(count.cell.text).toBe('1')
    // Never cited, not even as counts: the internal backlog is not in the document.
    expect(JSON.stringify(skeleton.sourceNotes)).not.toContain(jira)
    // The gates know whose data each tracker holds.
    expect(gathered.context.trackers).toEqual({ [ADO]: 'client', [jira]: 'internal' })
    // The internal backlog is read by no block: neither in the snapshot nor in the freshness.
    expect(snapshot.tracker.map((t) => t.sourceId)).toEqual([ADO])
    expect(gathered.freshness.map((f) => f.source)).not.toContain(`tracker:${jira}`)
    // The same internal recipe counts both.
    const internal = await gather(store)
    expect(rowsOf(internal.gathered, 'closed').map((r) => r.values.id)).toEqual(['INT-7', '101'])
  })

  it('a section of the internal version reads every tracker, also in a run for the client', async () => {
    const { store, jira } = withInternalBacklog()
    const { gathered, snapshot } = await gatherRecipeData(forClientRun(true), OCTOBER, deps(store))
    expect(rowsOf(gathered, 'closed').map((r) => r.values.id)).toEqual(['INT-7', '101'])
    expect(snapshot.tracker.map((t) => t.sourceId).sort()).toEqual([ADO, jira].sort())
  })

  it('the sprint deliverable groups under the feature as the PM decided along the chain', async () => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../recipes/deliverable-sprint.json'), 'utf8'),
    ).recipe
    const v = validateRecipe(raw)
    if (!v.ok) throw new Error('invalid recipe')
    const store = fakeStore()
    const item = (id: string, type: string, parentId: string | null, inSprint = true) => ({
      sourceId: ADO,
      kind: 'ado' as const,
      externalId: id,
      url: null,
      fields: {
        title: id,
        type,
        state: 'Active',
        iterationPath: inSprint ? 'Apollo\\[APO] Sprint 28' : 'Apollo\\Backlog',
        ...(parentId === null ? {} : { parentId }),
        changedAt: '2026-10-20T10:00:00.000Z',
      },
    })
    store.items = [
      item('F1', 'Feature', null, false),
      item('F2', 'Feature', null, false),
      // Left out by the PM: never the feature of what is under it.
      item('P1', 'Product Backlog Item', 'F1'),
      item('B1', 'Bug', 'P1'),
      // Under F2 in the tracker, attributed to F3 by the PM: so is what is under it.
      item('P2', 'Product Backlog Item', 'F2'),
      item('B2', 'Bug', 'P2'),
      // A Jira-like sub-task is never counted.
      item('S1', 'Sub-task', 'P2'),
    ]
    const { gathered } = await gatherRecipeData(
      v.recipe,
      {
        ...OCTOBER,
        sprint: { type: 'text', value: '[APO] Sprint 28' },
        closed_states: { type: 'rows', rows: [{ state: 'Closed' }] },
        bug_type: { type: 'text', value: 'Bug' },
        cr_type: { type: 'text', value: 'Change Request' },
        excluded_items: { type: 'work_item_selection', items: [{ sourceId: ADO, id: 'P1' }] },
        attributions: { type: 'rows', rows: [{ item: 'P2', feature: 'F3' }] },
      },
      deps(store),
    )
    // F3 is named by the PM and is no work item: shown as the PM wrote it.
    expect(rowsOf(gathered, 'by_feature').map((r) => [r.values.key, r.values.count])).toEqual([
      ['F3', 2],
      ['F1 (F1)', 1],
    ])
  })

  it('a feature is shown by its title', async () => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../recipes/deliverable-sprint.json'), 'utf8'),
    ).recipe
    const v = validateRecipe(raw)
    if (!v.ok) throw new Error('invalid recipe')
    const store = fakeStore()
    const item = (id: string, title: string | null, type: string, parentId: string | null) => ({
      sourceId: ADO,
      kind: 'ado' as const,
      externalId: id,
      url: null,
      fields: {
        ...(title === null ? {} : { title }),
        type,
        state: 'Active',
        iterationPath: type === 'Feature' ? 'Apollo\\Backlog' : 'Apollo\\[APO] Sprint 28',
        ...(parentId === null ? {} : { parentId }),
        changedAt: '2026-10-20T10:00:00.000Z',
      },
    })
    store.items = [
      item('29736', 'Accesso con SSO', 'Feature', null),
      item('29737', null, 'Feature', null),
      item('501', 'Login', 'Product Backlog Item', '29736'),
      item('502', 'Logout', 'Product Backlog Item', '29736'),
      item('503', 'Profilo', 'Product Backlog Item', '29737'),
      // Under a feature the connector did not read.
      item('504', 'Notifiche', 'Product Backlog Item', '29999'),
    ]
    const { gathered } = await gatherRecipeData(
      v.recipe,
      {
        ...OCTOBER,
        sprint: { type: 'text', value: '[APO] Sprint 28' },
        closed_states: { type: 'rows', rows: [{ state: 'Closed' }] },
        bug_type: { type: 'text', value: 'Bug' },
        cr_type: { type: 'text', value: 'Change Request' },
      },
      deps(store),
    )
    expect(rowsOf(gathered, 'by_feature').map((r) => [r.values.key, r.values.count])).toEqual([
      ['Accesso con SSO (29736)', 2],
      ['29737 (titolo non letto)', 1],
      ['29999 (titolo non letto)', 1],
    ])
    // The list of the perimeter names the feature in the tracker the same way, from the tracker.
    const items = rowsOf(gathered, 'sprint_items')
    expect(items.map((r) => [r.values.id, r.values.parent])).toEqual([
      ['501', 'Accesso con SSO (29736)'],
      ['502', 'Accesso con SSO (29736)'],
      ['503', '29737 (titolo non letto)'],
      ['504', '29999 (titolo non letto)'],
    ])
    expect(items[0]?.refs.parent).toEqual({ kind: 'work_item', sourceId: ADO, id: '501' })
  })

  it('a client value counting a list of the internal version counts only the client trackers', async () => {
    const { store, jira } = withInternalBacklog()
    // The count reaches the client; the list it counts stays in the internal version.
    const base = forClientRun(true)
    const value = base.sections.flatMap((s) => s.blocks).find((b) => b.id === 'closed_count')
    if (!value) throw new Error('no value')
    const r: Recipe = {
      ...base,
      sections: base.sections.map((s) =>
        s.id === 'summary'
          ? { ...s, version: 'both' as const, blocks: [...s.blocks, value] }
          : { ...s, blocks: s.blocks.filter((b) => b.id !== 'closed_count') },
      ),
    }
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(store))
    // The list the value counts is read as the client's, and says what it left out.
    expect(rowsOf(gathered, 'closed').map((x) => x.values.id)).toEqual(['101'])
    const closed = gathered.blocks.closed
    expect(closed?.status === 'read' && closed.remarks).toEqual([
      { code: 'internal_source_left_out', source: 'Backlog interno' },
    ])
    const { skeleton } = buildSkeleton(r, gathered)
    const count = blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>
    expect(count.cell.text).toBe('1')
    // Not even the counts of the internal backlog are a note of the document.
    expect(JSON.stringify(skeleton.sourceNotes)).not.toContain(jira)
    const doc = mergeDocument(skeleton, {}) as InternalDocument
    const { report } = projectClientVersion(doc, {
      recipe: r,
      policy: clientPolicy(),
      evidence: gathered.context.evidence,
      facts: gathered.context.facts,
      parameters: gathered.parameterTexts,
      trackers: gathered.context.trackers ?? {},
    })
    expect(report.anomalies.filter((a) => a.ref.element === 'value')).toEqual([])
  })

  it('a client value citing the counts of an internal tracker is an anomaly, never silent', async () => {
    const { store, jira } = withInternalBacklog()
    const base = forClientRun(true)
    const value = base.sections.flatMap((s) => s.blocks).find((b) => b.id === 'closed_count')
    if (!value) throw new Error('no value')
    const r: Recipe = {
      ...base,
      sections: base.sections.map((s) =>
        s.id === 'summary'
          ? { ...s, version: 'both' as const, blocks: [...s.blocks, value] }
          : { ...s, blocks: s.blocks.filter((b) => b.id !== 'closed_count') },
      ),
    }
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(store))
    const { skeleton } = buildSkeleton(r, gathered)
    // Should a count of the internal backlog reach the value all the same, the gate says so.
    const n = Math.max(...skeleton.sourceNotes.map((x) => x.n)) + 1
    const internalCounts: DocumentSourceRef = {
      kind: 'work_item_counts',
      sourceId: jira,
      query: 'closed',
    }
    const doc = mergeDocument(
      {
        ...skeleton,
        sourceNotes: [
          ...skeleton.sourceNotes,
          { n, label: 'Backlog interno, conteggi', dataAsOf: null, ref: internalCounts },
        ],
        sections: skeleton.sections.map((s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.kind === 'value' && b.id === 'closed_count'
              ? { ...b, cell: { ...b.cell, sources: [...b.cell.sources, n] } }
              : b,
          ),
        })),
      },
      {},
    ) as InternalDocument
    const { report } = projectClientVersion(doc, {
      recipe: r,
      policy: clientPolicy(),
      evidence: gathered.context.evidence,
      facts: gathered.context.facts,
      parameters: gathered.parameterTexts,
      trackers: gathered.context.trackers ?? {},
    })
    expect(
      report.anomalies.filter((a) => a.ref.element === 'value').map((a) => [a.code, a.ref]),
    ).toEqual([
      ['internal_data_in_client', { element: 'value', section: 'summary', block: 'closed_count' }],
    ])
  })

  it('a client document without a tracker of the client says so, never counts zero', async () => {
    const store = fakeStore()
    ;(store.trackers[0] as { audience: string }).audience = 'internal'
    const { gathered } = await gatherRecipeData(forClientRun(), OCTOBER, deps(store))
    expect(gathered.blocks.closed).toEqual({
      status: 'not_deduced',
      reason: 'no_client_source',
      remarks: [{ code: 'internal_source_left_out', source: 'Backlog Apollo' }],
    })
  })

  it('an empty sprint scope is reported, not counted as zero', async () => {
    const inSprint = (sprint: string) => {
      const r = structuredClone(recipe)
      const closed = r.sections.flatMap((s) => s.blocks).find((b) => b.id === 'closed')
      if (closed?.kind !== 'data_table' || closed.query.kind !== 'tracker') throw new Error('x')
      closed.query.filter = { ...closed.query.filter, sprints: [sprint] }
      return r
    }
    const store = fakeStore()
    const named = (store.items[0] as { fields: Record<string, unknown> }).fields
    named.iterationPath = 'Apollo\\[APO] Sprint 28'
    // The name the tracker writes: the block reads its work item.
    const found = await gatherRecipeData(inSprint('[APO] Sprint 28'), OCTOBER, deps(store))
    expect(rowsOf(found.gathered, 'closed').map((r) => r.values.id)).toEqual(['101'])
    expect(found.gathered.context.remarks).toEqual({})
    // A name of the cadence the tracker does not use: no work item, never a count of zero.
    const r = inSprint('Sprint 3')
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(store))
    expect(gathered.blocks.closed).toEqual({
      status: 'not_deduced',
      reason: 'sprint_not_found',
      remarks: [{ code: 'sprint_not_found', sprint: 'Sprint 3' }],
    })
    const { skeleton } = buildSkeleton(r, gathered)
    const count = blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>
    expect(count.cell.text).toBeNull()
    // The PM reads why, with the red-team.
    const warnings = blockRemarkWarnings(
      mergeDocument(skeleton, {}) as InternalDocument,
      gathered.context.remarks ?? {},
      'it',
    )
    expect(warnings.map((w) => redTeamFindingText(w, 'it'))).toEqual([
      'Lettura dei dati in “Feature chiuse” della sezione “Avanzamento ottobre 2026”: Nessun elemento trovato per lo sprint «Sprint 3»: controlla il nome, che va scritto come nel tracker.',
    ])
  })

  it('leaves a tracker never synced to the end not deduced', async () => {
    const store = fakeStore()
    ;(store.trackers[0] as { lastSuccessAt: Date | null }).lastSuccessAt = null
    const { gathered } = await gather(store)
    expect(gathered.blocks.closed).toEqual({
      status: 'not_deduced',
      reason: 'source_not_synced',
      remarks: [{ code: 'source_not_synced', source: 'Backlog Apollo' }],
    })
    const skeleton = buildSkeleton(recipe, gathered).skeleton
    expect((blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>).cell.text).toBe(
      null,
    )
    expect(gathered.freshness.find((f) => f.source === `tracker:${ADO}`)?.level).toBe('unknown')
  })

  it('cites a tracker never synced inside the scope in every count, of unknown age', async () => {
    const store = fakeStore()
    const jira = 'src-jira' as SourceId
    store.trackers.push({
      ...(store.trackers[0] as TrackerSourceView),
      sourceId: jira,
      kind: 'jira',
      label: 'Jira Apollo',
      lastSuccessAt: null,
      firstSuccessAt: null,
      dataAsOf: null,
    })
    const { gathered } = await gather(store)
    const closed = gathered.blocks.closed
    expect(closed?.status === 'read' && closed.remarks).toEqual([
      { code: 'source_not_synced', source: 'Jira Apollo' },
    ])
    expect(gathered.freshness.find((f) => f.source === `tracker:${jira}`)?.level).toBe('unknown')
    const { skeleton } = buildSkeleton(recipe, gathered)
    const count = blockOf(skeleton, 'closed_count') as Extract<Block, { kind: 'value' }>
    const cited = skeleton.sourceNotes.filter((n) => count.cell.sources.includes(n.n))
    expect(cited.map((n) => [n.label, n.dataAsOf])).toEqual([
      ['Backlog Apollo, conteggi', hoursAgo(2).toISOString()],
      ['Jira Apollo, conteggi', null],
    ])
    // The freshness gate judges that source unknown: the count is suspended, never silent.
    const gates = runCommonGates(mergeDocument(skeleton, {}) as InternalDocument, {
      recipe,
      lang: 'it',
      parameters: gathered.parameterTexts,
      periods: gathered.periods,
      knownNames: [],
      freshness: gathered.context.freshness,
      contestedFacts: [],
      contradictions: [],
      declaredValues: [],
      slotVerifications: {},
      acceptances: [],
      decisions: [],
    })
    expect(
      gates.anomalies.some(
        (a) =>
          a.code === 'source_freshness_unknown' &&
          a.ref.element === 'source' &&
          a.ref.source === `tracker:${jira}`,
      ),
    ).toBe(true)
  })

  it('leaves an undated system export without a date, and out of every period', async () => {
    const store = fakeStore()
    store.evidence.push({
      ...(store.evidence[0] as RecipeEvidenceView),
      id: 'ev-sys',
      title: 'Export ADO',
      sourceId: 'src-ado',
      sourceKind: 'ado',
      originSource: 'acquisition',
      dateSource: 'acquisition',
      policy: 'system',
      date: hoursAgo(24 * 8),
    })
    store.locators['ev-sys'] = { kind: 'page', page: 1 }
    const listed = rowsOf((await gather(store)).gathered, 'docs')
    expect(listed.find((r) => r.values.title === 'Export ADO')?.values.date).toBeNull()

    const periodic = structuredClone(recipe)
    const docs = periodic.sections[3]?.blocks[0]
    if (docs?.kind !== 'data_list' || docs.query.kind !== 'evidence') throw new Error('docs')
    docs.query.period = { parameter: 'period' }
    const { gathered } = await gatherRecipeData(periodic, OCTOBER, deps(store))
    expect(rowsOf(gathered, 'docs').map((r) => r.values.title)).toEqual(['Contratto quadro'])
  })

  it('leaves a block not deduced when an optional date the PM skipped would widen it', async () => {
    const r = structuredClone(recipe)
    ;(r.parameters as unknown[]).push({
      id: 'cutoff',
      type: 'date',
      label: 'Data limite',
      required: false,
      step: 1,
    })
    const closed = r.sections[1]?.blocks[0]
    if (closed?.kind !== 'data_table' || closed.query.kind !== 'tracker') throw new Error('closed')
    closed.query.filter.dates = { field: 'closed', to: { parameter: 'cutoff' } }
    const store = fakeStore()
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(store))
    expect(gathered.blocks.closed).toEqual({ status: 'not_deduced', reason: 'parameter_skipped' })
    expect(store.calls.some((c) => c.startsWith('trackerItems'))).toBe(false)
    // A list filter of an optional parameter skipped is dropped, and the PM is told.
    closed.query.filter = { types: [{ parameter: 'kind' }] }
    ;(r.parameters as unknown[]).push({
      id: 'kind',
      type: 'text',
      label: 'Tipo',
      required: false,
      step: 1,
      maxLength: 50,
    })
    const wide = (await gatherRecipeData(r, OCTOBER, deps(fakeStore()))).gathered.blocks.closed
    expect(wide?.status === 'read' && wide.remarks).toEqual([
      { code: 'filter_dropped', parameter: 'Tipo' },
    ])
  })

  it('tells how many of the items the PM selected are no longer there', async () => {
    const { gathered } = await gather(fakeStore(), {
      ...OCTOBER,
      chosen: { type: 'evidence_selection', evidenceIds: ['ev-mail', 'ev-unknown', 'ev-contract'] },
    })
    const chosen = gathered.blocks.chosen_docs
    expect(chosen?.status === 'read' && chosen.remarks).toEqual([
      { code: 'selection_dropped', count: 2 },
    ])
  })

  it('compares a filter of the warehouse as numbers when both are numbers, else as texts', async () => {
    const r = structuredClone(recipe)
    const positions = r.sections[0]?.blocks[0]
    if (positions?.kind !== 'data_table' || positions.query.kind !== 'system_rows') {
      throw new Error('positions')
    }
    positions.query.where = [
      { column: 'lineid', equals: '2' },
      { column: 'status', equals: 'APERTO' },
    ]
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(fakeStore()))
    expect(rowsOf(gathered, 'positions').map((row) => row.values.item)).toEqual(['Sviluppo'])
    positions.query.where = [{ column: 'salesorderid', equals: 1 }]
    const none = await gatherRecipeData(r, OCTOBER, deps(fakeStore()))
    expect(rowsOf(none.gathered, 'positions')).toEqual([])
    // A code with leading zeros is a text: «02» is not line 2.
    positions.query.where = [{ column: 'lineid', equals: '02' }]
    const zeros = await gatherRecipeData(r, OCTOBER, deps(fakeStore()))
    expect(rowsOf(zeros.gathered, 'positions')).toEqual([])
  })

  it('leaves a block of the warehouse not deduced when an equality the PM skipped would widen it', async () => {
    const r = structuredClone(recipe)
    ;(r.parameters as unknown[]).push({
      id: 'order',
      type: 'text',
      label: 'Ordine',
      required: false,
      step: 1,
      maxLength: 20,
    })
    const positions = r.sections[0]?.blocks[0]
    if (positions?.kind !== 'data_table' || positions.query.kind !== 'system_rows') {
      throw new Error('positions')
    }
    positions.query.where = [{ column: 'salesorderid', equals: { parameter: 'order' } }]
    const store = fakeStore()
    const { gathered } = await gatherRecipeData(r, OCTOBER, deps(store))
    expect(gathered.blocks.positions).toEqual({
      status: 'not_deduced',
      reason: 'parameter_skipped',
    })
    expect(store.calls.some((c) => c.startsWith('systemViews'))).toBe(false)
    const given = await gatherRecipeData(
      r,
      { ...OCTOBER, order: { type: 'text', value: 'SO-1' } },
      deps(fakeStore()),
    )
    expect(rowsOf(given.gathered, 'positions')).toHaveLength(2)
  })

  it('reads a day of the warehouse as the day in Italy', async () => {
    const store = fakeStore()
    const row = store.views[0]?.rows[0] as { values: Record<string, unknown> }
    row.values.salesorderdate = '2026-09-30T23:30:00'
    const { gathered } = await gather(store)
    expect(rowsOf(gathered, 'positions')[0]?.values.salesorderdate).toEqual({ day: '2026-10-01' })
  })

  it('leaves a block with too many rows not deduced, never cut', async () => {
    const store = fakeStore()
    const base = store.evidence[0] as RecipeEvidenceView
    store.evidence = Array.from({ length: MAX_BLOCK_ROWS + 1 }, (_, i) => ({
      ...base,
      id: `ev-${i}`,
    }))
    const { gathered } = await gather(store)
    expect(gathered.blocks.docs).toEqual({ status: 'not_deduced', reason: 'too_many_rows' })
  })

  it('keeps in the snapshot the fingerprint of every row, the values of a few thousand', async () => {
    const small = (await gather()).snapshot
    expect(small.systemRows[0]?.valuesHash).toMatch(/^sha256:/)
    expect(small.systemRows[0]?.values).toBeDefined()
    const store = fakeStore()
    const view = store.views[0] as unknown as {
      rows: Array<{ key: string; values: Record<string, unknown> }>
    }
    const first = view.rows[0] as { values: Record<string, unknown> }
    view.rows = Array.from({ length: 2_001 }, (_, i) => ({
      key: `SO-1|${i}`,
      values: { ...first.values, lineid: i },
    }))
    const big = (await gather(store)).snapshot
    expect(big.systemRows).toHaveLength(2_001)
    expect(
      big.systemRows.every((r) => r.values === undefined && r.valuesHash.startsWith('sha256:')),
    ).toBe(true)
  })

  it('leaves out evidence removed at the source', async () => {
    const { gathered, snapshot } = await gather()
    const titles = rowsOf(gathered, 'docs').map((r) => r.values.title)
    expect(titles).toEqual(['Contratto quadro', 'Export backlog.xlsx'])
    expect(gathered.removedEvidence).toEqual(['ev-mail'])
    expect(snapshot.removals).toEqual([
      { evidenceId: 'ev-mail', removedAt: hoursAgo(1).toISOString() },
    ])
    // A fact whose only source was removed is left out too.
    const facts = rowsOf(gathered, 'economics').map((r) => r.values.statement)
    expect(facts).not.toContain('La penale è del 5%.')
    expect(JSON.stringify(gathered.notes)).not.toContain('ev-mail')
    // A selection of the PM does not bring it back either.
    const chosen = await gather(fakeStore(), {
      ...OCTOBER,
      chosen: { type: 'evidence_selection', evidenceIds: ['ev-mail', 'ev-contract'] },
    })
    expect(rowsOf(chosen.gathered, 'chosen_docs').map((r) => r.values.title)).toEqual([
      'Contratto quadro',
    ])
  })

  it('shows both sides when two sources disagree on an amount', async () => {
    const { gathered } = await gather()
    expect(gathered.contradictions).toEqual([
      {
        key: 'fact:fact-contract',
        subject: 'Le fonti danno valori diversi su un dato di tipo «dati economici»',
        sides: [
          { value: '120.000', source: { kind: 'fact', factId: 'fact-contract' } },
          {
            value: '125.000',
            source: {
              kind: 'evidence',
              evidenceId: 'ev-minutes',
              locator: { kind: 'page', page: 2 },
            },
          },
        ],
      },
    ])
    // Shown, never resolved: the table keeps the current value, the decision is the PM's.
    const values = rowsOf(gathered, 'economics').map((r) => r.values.value)
    expect(values).toContain('120.000')
  })

  it('uses the PM correction over a newer extraction', async () => {
    const { gathered } = await gather()
    const budget = rowsOf(gathered, 'economics').find(
      (r) => r.values.statement === 'Il budget è 100.000 euro.',
    )
    expect(budget?.values.value).toBe('100.000')
    expect(gathered.contradictions.map((c) => c.key)).not.toContain('fact:fact-budget')
    expect(gathered.contestedFacts).toEqual([])
  })

  it('keeps a contested fact whose other side is not readable as contested', async () => {
    const store = fakeStore()
    const contested = store.facts[0] as unknown as {
      candidates: Array<{ sources: Array<{ evidenceId: string }> }>
    }
    ;(contested.candidates[0]?.sources[0] as { evidenceId: string }).evidenceId = 'ev-mail'
    const { gathered } = await gather(store)
    expect(gathered.contradictions).toEqual([])
    expect(gathered.contestedFacts).toEqual(['fact-contract'])
  })

  it('writes every value it reads in the read log', async () => {
    const { gathered } = await gather()
    const logged = new Map(gathered.readLog.map((r) => [canonicalJson(r.ref), r.values]))
    for (const block of Object.values(gathered.blocks)) {
      if (block.status !== 'read') continue
      for (const row of block.rows) {
        for (const [field, ref] of Object.entries(row.refs)) {
          const read = logged.get(canonicalJson(ref as DocumentSourceRef))
          expect(read, `${field} of ${canonicalJson(ref)}`).toBeDefined()
          expect(read?.[field]).toEqual(row.values[field])
        }
      }
    }
    // Every place cited by the skeleton has its note and its read.
    const { skeleton } = buildSkeleton(recipe, gathered)
    for (const note of skeleton.sourceNotes) {
      // A row of the warehouse is read whole; the skeleton cites it with the columns it shows.
      const read = note.ref.kind === 'system_row' ? { ...note.ref, columns: undefined } : note.ref
      expect(logged.has(canonicalJson(read))).toBe(true)
    }
    expect(logged.get(canonicalJson({ kind: 'parameter', parameterId: 'period' }))).toEqual({
      value: 'ottobre 2026',
    })
  })

  it('declares a manual export dated by acquisition as such', async () => {
    const { gathered } = await gather()
    const note = gathered.notes.find(
      (n) => n.ref.kind === 'evidence' && n.ref.evidenceId === 'ev-backlog',
    )
    expect(note?.label).toBe(
      'Export backlog.xlsx (datato al caricamento: il documento non indica una sua data)',
    )
    expect(note?.dataAsOf).toBe(hoursAgo(5).toISOString())
    expect(gathered.freshness.find((f) => f.source === 'evidence:ev-backlog')).toMatchObject({
      policy: 'system',
      datedByAcquisition: true,
    })
    const dated = gathered.notes.find(
      (n) => n.ref.kind === 'evidence' && n.ref.evidenceId === 'ev-contract',
    )
    expect(dated?.label).toBe('Contratto quadro')
  })

  it('marks a section not deduced when a mandatory parameter was skipped', async () => {
    const store = fakeStore()
    const { gathered } = await gather(store, {})
    expect(gathered.blocks.closed).toEqual({ status: 'not_deduced', reason: 'parameter_skipped' })
    // Not even read: a skipped parameter never widens a query.
    expect(store.calls.some((c) => c.startsWith('trackerItems'))).toBe(false)
    const { skeleton } = buildSkeleton(recipe, gathered)
    const progress = skeleton.sections.find((s) => s.id === 'progress')
    expect(progress?.notDeduced).toBe(true)
    expect(progress?.title).toBe('Avanzamento non dedotto')
    expect(skeleton.sections.find((s) => s.id === 'order')?.notDeduced).toBe(false)
  })

  it('gives the gates what they need to know of the sources read', async () => {
    const { gathered } = await gather()
    expect(gathered.context.freshness.sourceKinds).toEqual({
      [DWSI]: 'netsuite_dwsi',
      [ADO]: 'ado',
    })
    expect(gathered.context.evidence['ev-contract']).toEqual({
      kind: 'contract',
      audience: 'internal',
      fromSystem: false,
      title: 'Contratto quadro',
    })
    expect(gathered.context.facts['fact-contract']).toEqual({
      kind: 'economics',
      clientOnly: false,
    })
    expect(gathered.context.freshness.facts['fact-contract']).toEqual({ policy: 'document' })
    expect(gathered.periods).toEqual({ period: { from: '2026-10-01', to: '2026-10-31' } })
    expect(gathered.parameterTexts).toEqual({ period: 'ottobre 2026' })
  })

  it('refuses a value that does not fit its parameter, before reading anything', async () => {
    const store = fakeStore()
    await expect(
      gather(store, { period: { type: 'period', from: '2026-11-01', to: '2026-10-01' } }),
    ).rejects.toThrow(DomainError)
    expect(store.calls).toEqual([])
  })

  it('reads every amount of the warehouse as a number, never as a text with a dot', async () => {
    const { gathered } = await gather()
    const { skeleton } = buildSkeleton(recipe, gathered)
    const positions = blockOf(skeleton, 'positions') as Extract<Block, { kind: 'table' }>
    expect(positions.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['SO-1', '1', '12.000,00', '8.000,00', '01/09/2026'],
      ['SO-1', '2', '30.000,50', '0,00', '01/09/2026'],
    ])
    expect(positions.rows.map((r) => r.key)).toEqual(['["SO-1","1"]', '["SO-1","2"]'])
    const total = blockOf(skeleton, 'order_total') as Extract<Block, { kind: 'value' }>
    expect(total.cell.text).toBe('42.000,50')
    const note = skeleton.sourceNotes.find((n) => n.n === total.cell.sources[0])
    expect(note?.ref).toEqual({
      kind: 'system_row',
      sourceId: DWSI,
      view: 'v_sales_order_all',
      key: [
        { column: 'projectid', value: 'PRJ000123' },
        { column: 'salesorderid', value: 'SO-1' },
        { column: 'lineid', value: '1' },
      ],
      columns: ['amount', 'invoiced', 'lineid', 'salesorderdate', 'salesorderid'],
    })
  })
})
