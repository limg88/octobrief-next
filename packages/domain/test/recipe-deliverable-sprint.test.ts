import { describe, expect, it } from 'vitest'
import {
  classify,
  deliverableFileName,
  type InternalDocument,
  type ParameterValues,
  projectClientVersion,
  type Recipe,
  runRecipeChecks,
  type SlotContent,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  blockIn,
  cellsOf,
  deliveryRecipe,
  draftOf,
  gatherDelivery,
  project,
  TRACKER,
  valueText,
  workItemsOf,
} from './support/delivery-recipes.ts'

// The Deliverable Sprint of the library on the synthetic delivery project: sprint 14, three
// features, one story without a feature, a bug blocked by the client, a CR.

const p = project()
const sprint = p.tracker.sprint
const inSprint = p.tracker.items.filter((i) => i.sprint === sprint.id)
const orphan = inSprint.find((i) => i.feature === null)
if (!orphan) throw new Error('the synthetic sprint has an item without a feature')

interface Over {
  excluded?: string[]
  attributions?: Array<Record<string, string>>
  period?: { type: 'period'; from: string; to: string }
}

function params(over: Over = {}): ParameterValues {
  return {
    period: over.period ?? { type: 'period', from: sprint.start, to: sprint.end },
    sprint: { type: 'text', value: sprint.id },
    closed_states: { type: 'rows', rows: [{ state: 'Done' }] },
    bug_type: { type: 'text', value: 'bug' },
    cr_type: { type: 'text', value: 'cr' },
    ...(over.excluded
      ? {
          excluded_items: {
            type: 'work_item_selection',
            items: over.excluded.map((id) => ({ sourceId: TRACKER, id })),
          },
        }
      : {}),
    ...(over.attributions ? { attributions: { type: 'rows', rows: over.attributions } } : {}),
  }
}

function run(
  over: Over = {},
  slots: Record<string, SlotContent> = {},
  recipe: Recipe = deliveryRecipe('deliverable-sprint'),
) {
  const gathered = gatherDelivery(recipe, p, params(over))
  return { recipe, gathered, ...draftOf(recipe, gathered, slots) }
}

const failing = (recipe: Recipe, draft: InternalDocument) =>
  runRecipeChecks(draft, {
    recipe,
    lang: 'it',
    parameters: {},
    periods: { period: { from: sprint.start, to: sprint.end } },
    declaredValues: [],
  }).anomalies.map((a) => ({ check: (a.ref as { check: string }).check, detail: a.detail }))

describe('the Deliverable Sprint recipe', () => {
  it('is a valid recipe for the client, with the sections of a sprint deliverable in order', () => {
    const recipe = deliveryRecipe('deliverable-sprint')
    expect(recipe.audience).toBe('client')
    expect(recipe.sections.map((s) => [s.id, s.version])).toEqual([
      ['cover', 'both'],
      ['overview', 'both'],
      ['features', 'both'],
      ['bugs', 'both'],
      ['team', 'internal'],
      ['next', 'both'],
      ['perimeter', 'internal'],
    ])
    expect(recipe.render.formats).toEqual(['md', 'pptx'])
  })

  it('counts the sprint from the tracker, each item once, the features adding up to the total', () => {
    const { recipe, draft } = run()
    expect(valueText(draft, 'items_total')).toBe(String(inSprint.length))
    const closed = inSprint.filter((i) => i.state === 'Done').length
    expect(valueText(draft, 'closed_total')).toBe(String(closed))
    const byFeature = cellsOf(draft, 'by_feature')
    const counted = byFeature.reduce((n, r) => n + Number(r[1]), 0)
    expect(counted).toBe(inSprint.length)
    for (const f of p.tracker.features) {
      const expected = inSprint.filter((i) => i.feature === f.id).length
      expect(byFeature.find((r) => r[0] === f.id)?.[1]).toBe(String(expected))
    }
    expect(cellsOf(draft, 'bugs_by_state').reduce((n, r) => n + Number(r[1]), 0)).toBe(
      inSprint.filter((i) => i.type === 'bug').length,
    )
    expect(cellsOf(draft, 'crs_by_state').reduce((n, r) => n + Number(r[1]), 0)).toBe(
      inSprint.filter((i) => i.type === 'cr').length,
    )
    expect(failing(recipe, draft)).toEqual([])
  })

  it('never lets the model attribute an item', () => {
    // The item without a feature stays out of every feature row: «da attribuire» to the PM.
    const { recipe, draft } = run()
    const rows = cellsOf(draft, 'by_feature')
    expect(rows.find((r) => r[0] === null)?.[1]).toBe('1')
    expect(cellsOf(draft, 'sprint_items').find((r) => r[0] === orphan.id)?.[3]).toBeNull()
    // Whatever the writer says, the tables are the skeleton's.
    const slots: Record<string, SlotContent> = {
      overview_text: {
        segments: [
          {
            text: `Attribuiamo ${orphan.id} alla feature F1.`,
            nature: 'inference',
            category: 'other',
            sources: [],
          },
        ],
      },
    }
    const written = run({}, slots).draft
    expect(blockIn(written, 'by_feature')).toEqual(blockIn(draft, 'by_feature'))
    expect(blockIn(written, 'attributed')).toEqual(blockIn(draft, 'attributed'))
    expect(failing(recipe, draft)).toEqual([])
    // And the sentence that claims it, without a source, is an anomaly of the text.
    expect(failing(recipe, written)).toEqual([
      { check: 'overview_bounded', detail: expect.objectContaining({ connectors: 1 }) },
    ])
    // Only the PM attributes it, and never one item both attributed and excluded.
    const byPm = run({ attributions: [{ item: orphan.id, feature: 'F1' }] })
    expect(cellsOf(byPm.draft, 'attributed')).toEqual([[orphan.id, 'F1']])
    expect(failing(byPm.recipe, byPm.draft)).toEqual([])
    const both = run({
      attributions: [{ item: orphan.id, feature: 'F1' }],
      excluded: [orphan.id],
    })
    expect(failing(both.recipe, both.draft)).toContainEqual({
      check: 'perimeter_covered',
      detail: expect.objectContaining({ overlapping: 1 }),
    })
  })

  it('leaves an item the PM excluded out of every count', () => {
    const { recipe, draft } = run({ excluded: [orphan.id] })
    expect(valueText(draft, 'items_total')).toBe(String(inSprint.length - 1))
    expect(cellsOf(draft, 'by_feature').find((r) => r[0] === null)).toBeUndefined()
    // The perimeter still lists it, as excluded by the PM.
    expect(cellsOf(draft, 'sprint_items').map((r) => r[0])).toContain(orphan.id)
    expect(cellsOf(draft, 'excluded').map((r) => r[0])).toEqual([orphan.id])
    expect(failing(recipe, draft)).toEqual([])
  })

  it('counts an item the PM attributed under its feature', () => {
    const { recipe, draft } = run({ attributions: [{ item: orphan.id, feature: 'F1' }] })
    const f1 = inSprint.filter((i) => i.feature === 'F1').length
    expect(cellsOf(draft, 'by_feature').find((r) => r[0] === 'F1')?.[1]).toBe(String(f1 + 1))
    expect(cellsOf(draft, 'by_feature').find((r) => r[0] === null)).toBeUndefined()
    // The row of the item still shows what the tracker says.
    expect(cellsOf(draft, 'sprint_items').find((r) => r[0] === orphan.id)?.[3]).toBeNull()
    expect(failing(recipe, draft)).toEqual([])
  })

  it('the sprint deliverable groups work under its feature', () => {
    const base = workItemsOf(p)
    const at = base[0]
    if (!at) throw new Error('no item')
    const sprintItem = (externalId: string, type: string, parent: string | null) => ({
      ...at,
      externalId,
      summary: externalId,
      type,
      parent,
      state: 'Done',
      sprint: sprint.id,
      storyPoints: null,
    })
    // A feature of the backlog (not in the sprint), a backlog item under it, two tasks under the
    // backlog item, and a backlog item whose chain ends without a feature.
    const items = [
      ...base,
      { ...sprintItem('FEAT-9', 'Feature', null), sprint: 'S10' },
      sprintItem('PBI-91', 'Product Backlog Item', 'FEAT-9'),
      sprintItem('TASK-911', 'Task', 'PBI-91'),
      sprintItem('TASK-912', 'Task', 'PBI-91'),
      sprintItem('PBI-92', 'Product Backlog Item', null),
    ]
    const recipe = deliveryRecipe('deliverable-sprint')
    const { draft } = draftOf(recipe, gatherDelivery(recipe, p, params(), items))
    // The tasks are never counted; the backlog item counts under its feature, never under itself.
    const byFeature = cellsOf(draft, 'by_feature')
    expect(byFeature.find((r) => r[0] === 'FEAT-9')?.[1]).toBe('1')
    expect(byFeature.find((r) => r[0] === 'PBI-91')).toBeUndefined()
    expect(valueText(draft, 'items_total')).toBe(String(inSprint.length + 2))
    expect(cellsOf(draft, 'sprint_items').map((r) => r[0])).not.toContain('TASK-911')
    // Counted by type, the types the PM chose.
    const byType = cellsOf(draft, 'sprint_by_type')
    expect(byType.find((r) => r[0] === 'Task')).toBeUndefined()
    expect(byType.find((r) => r[0] === 'Product Backlog Item')?.[1]).toBe('2')
    const chosen = draftOf(
      recipe,
      gatherDelivery(
        recipe,
        p,
        {
          ...params(),
          counted_types: {
            type: 'rows',
            rows: [{ type: 'Product Backlog Item' }, { type: 'Task' }],
          },
        },
        items,
      ),
    ).draft
    // Only what the PM chose, and never a task.
    expect(cellsOf(chosen, 'sprint_by_type').map((r) => [r[0], r[1]])).toEqual([
      ['Product Backlog Item', '2'],
    ])
    expect(valueText(chosen, 'items_total')).toBe('2')
  })

  it('sums the hours of the team within the sprint only', () => {
    const period = { type: 'period', from: '2026-10-27', to: sprint.end } as const
    const { draft } = run({ period })
    const inPeriod = (p.dwsi.v_timesheet_all ?? []).filter(
      (r) => String(r.timesheetdate) >= period.from && String(r.timesheetdate) <= period.to,
    )
    expect(inPeriod.length).toBeLessThan((p.dwsi.v_timesheet_all ?? []).length)
    expect(valueText(draft, 'hours_total')).toBe(
      String(inPeriod.reduce((n, r) => n + Number(r.duration), 0)),
    )
  })

  it('refuses an attribution of an item outside the sprint', () => {
    const outside = p.tracker.items.find((i) => i.sprint !== sprint.id)
    if (!outside) throw new Error('the synthetic tracker has an item of another sprint')
    const { recipe, draft } = run({ attributions: [{ item: outside.id, feature: 'F1' }] })
    expect(failing(recipe, draft).map((a) => a.check)).toEqual(['attributions_in_perimeter'])
  })

  it('refuses an item counted twice', () => {
    const { recipe, draft } = run()
    const items = blockIn(draft, 'sprint_items')
    if (items.kind !== 'table') throw new Error('no perimeter')
    items.rows.push(structuredClone(items.rows[0] as (typeof items.rows)[number]))
    const features = blockIn(draft, 'by_feature')
    if (features.kind !== 'table') throw new Error('no features')
    features.rows.push(structuredClone(features.rows[0] as (typeof features.rows)[number]))
    const checks = failing(recipe, draft).map((a) => a.check)
    expect(checks).toEqual(
      expect.arrayContaining([
        'items_counted_once',
        'features_counted_once',
        'feature_counts_total',
      ]),
    )
  })

  it('keeps story points in the internal version only', () => {
    expect(p.truth.hasStoryPoints).toBe(true)
    const { recipe, gathered, draft } = run()
    const { version, report } = projectClientVersion(draft, audienceOf(recipe, gathered))
    expect(report.warnings.map((w) => w.code)).not.toContain('story_points_in_client')
    const featuresTable = blockIn(draft, 'by_feature')
    if (featuresTable.kind !== 'table') throw new Error('no features table')
    expect(featuresTable.columns.map((c) => c.id)).toEqual(['feature', 'items'])
    const pointsTable = blockIn(draft, 'points_by_feature')
    if (pointsTable.kind !== 'table') throw new Error('no points table')
    expect(pointsTable.columns.map((c) => c.id)).toEqual(['feature', 'points'])
    const holder = draft.sections.find((sec) =>
      sec.blocks.some((blk) => blk.id === 'points_by_feature'),
    )
    expect(holder?.id).toBe('perimeter')
    const clientIds = version.document.sections.flatMap((sec) => sec.blocks.map((blk) => blk.id))
    expect(clientIds).not.toContain('points_by_feature')
    expect(version.document.sections.map((s) => s.id)).not.toContain('perimeter')
    expect(version.document.sections.map((s) => s.id)).not.toContain('team')
  })

  it('names its files so they never look like the deliverables of a contract', () => {
    const recipe = deliveryRecipe('deliverable-sprint')
    const name = deliverableFileName(
      { recipe: { slug: recipe.slug, version: recipe.version, title: recipe.title } },
      'client',
      'pptx',
    )
    const c = classify({
      fileName: name.replace(/\.pptx$/, '.md'),
      mediaType: 'text/markdown',
      text: `# ${recipe.title}\n`,
      lang: 'it',
      metadataDate: null,
      acquiredAt: p.now,
    })
    expect(name).toBe('deliverable-sprint-1.2.0-cliente.pptx')
    expect(c.kind).not.toBe('contract_deliverables')
  })
})
