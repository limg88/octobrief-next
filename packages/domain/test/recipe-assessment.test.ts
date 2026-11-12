import { describe, expect, it } from 'vitest'
import { generateAssessmentProject } from '../../../tools/synthetic/src/recipe-data.ts'
import {
  type AudienceContext,
  type GatheredData,
  type GatheredRow,
  type InternalDocument,
  projectClientVersion,
  type Recipe,
  runRecipeChecks,
  type SlotContent,
  type SlotSegment,
  typedRowsRead,
} from '../src/recipe/index.ts'
import {
  audienceOf,
  checksContext,
  draftOf,
  evidenceRef,
  gatheredFor,
  NOW,
  productRecipe,
  said,
  source,
} from './support/product-recipes.ts'

// The deliverable of a phase of an assessment on the synthetic assessment project: the generic
// skeleton in its internal and client versions. The outcome of the gate is what the PM proposes,
// with a fixed label; the model never states it, and estimates never reach the client.

const project = generateAssessmentProject({ seed: 3 })
const phase = project.phases[0]
if (!phase) throw new Error('the synthetic assessment has no phase')

const ids = new Map(project.documents.map((d, i) => [d.fileName, `ev-${i + 1}`]))
const idOf = (fileName: string): string => {
  const id = ids.get(fileName)
  if (id === undefined) throw new Error(`no document ${fileName}`)
  return id
}
const ESTIMATE = project.documents.find((d) => d.fileName.startsWith('Stima-interna'))
if (!ESTIMATE) throw new Error('the synthetic assessment has no internal estimate')
const ESTIMATE_TEXT = new TextDecoder().decode(ESTIMATE.bytes)
/** The effort of the internal estimate, as it states it («90 giornate»). */
const EFFORT = /(\d+ giornate)/u.exec(ESTIMATE_TEXT)?.[1] ?? ''

const at = (fileName: string) => source(evidenceRef(idOf(fileName), 1), fileName)

function row(fileName: string): GatheredRow {
  const ref = evidenceRef(idOf(fileName), 1)
  return {
    values: { title: fileName, date: { day: phase?.start ?? '' } },
    refs: { title: ref, date: ref },
  }
}

/** The checklist of the gate of a phase, each item with the outcome the PM gives it. */
type Checklist = Array<{ item: string; outcome: string }>

function gathered(
  recipe: Recipe,
  proposed: string | null,
  checklist: Checklist | null = null,
): GatheredData {
  const audienceDocs = (a: 'client' | 'internal') =>
    project.documents.filter((d) => d.audience === a).map((d) => d.fileName)
  const checklistParameter = recipe.parameters.find((p) => p.id === 'gate_checklist')
  const checklistBlock =
    checklist === null || checklistParameter?.type !== 'rows'
      ? { status: 'not_deduced' as const, reason: 'parameter_skipped' as const }
      : {
          status: 'read' as const,
          rows: typedRowsRead('gate_checklist', checklistParameter.columns, checklist),
          totals: [],
        }
  return gatheredFor(
    recipe,
    {
      phase_name: { type: 'text', value: phase?.name ?? '' },
      phase_period: { type: 'period', from: phase?.start ?? '', to: phase?.end ?? '' },
      ...(proposed === null ? {} : { proposed_outcome: { type: 'choice', value: proposed } }),
      ...(checklist === null ? {} : { gate_checklist: { type: 'rows', rows: checklist } }),
    },
    {
      phase_documents: { status: 'read', rows: audienceDocs('client').map(row), totals: [] },
      internal_documents: { status: 'read', rows: audienceDocs('internal').map(row), totals: [] },
      gate_checklist_table: checklistBlock,
    },
    project.documents.map((d) => ({
      ref: evidenceRef(idOf(d.fileName), 1),
      label: d.fileName,
      dataAsOf: NOW,
    })),
  )
}

/** What a scripted model writes: results from their documents, the estimate where it belongs. */
function slots(over: Record<string, SlotSegment[]> = {}): Record<string, SlotContent> {
  const base: Record<string, SlotSegment[]> = {
    results_text: (phase?.results ?? []).map((r) => said(`${r.statement}.`, [at(r.source)])),
    gate_rationale: (phase?.gate.criteria ?? []).map((c) =>
      said(
        `Criterio «${c}»: gli elementi sono nell'inventario.`,
        [at(phase?.results[0]?.source ?? '')],
        'inference',
      ),
    ),
    effort_text: [
      said(`Stima dell'impegno: ${EFFORT}.`, [at(ESTIMATE?.fileName ?? '')], 'fact', 'estimates'),
    ],
    next_steps_text: [said('Si propone di avviare la fase di analisi.', [], 'suggestion')],
    ...over,
  }
  return Object.fromEntries(Object.entries(base).map(([k, segments]) => [k, { segments }]))
}

function draft(
  recipe: Recipe,
  proposed: string | null,
  over: Record<string, SlotSegment[]> = {},
  checklist: Checklist | null = null,
) {
  const g = gathered(recipe, proposed, checklist)
  return { gathered: g, doc: draftOf(recipe, g, slots(over)) }
}

function audience(recipe: Recipe, g: GatheredData): AudienceContext {
  return audienceOf(
    recipe,
    g,
    Object.fromEntries(
      project.documents.map((d) => [
        idOf(d.fileName),
        { kind: 'generic', audience: d.audience, fromSystem: false, title: d.fileName },
      ]),
    ),
  )
}

const failedChecks = (recipe: Recipe, g: GatheredData, doc: InternalDocument) =>
  runRecipeChecks(doc, checksContext(recipe, g)).anomalies.map((a) => [
    a.ref.element === 'check' ? a.ref.check : null,
    a.code,
    a.class,
  ])

const blockValue = (doc: { sections: InternalDocument['sections'] }, id: string) => {
  for (const s of doc.sections) {
    for (const b of s.blocks) if (b.kind === 'value' && b.id === id) return b
  }
  return undefined
}

describe('the deliverable of an assessment phase', () => {
  it('the assessment client version drops estimates and keeps the proposed gate outcome', () => {
    const recipe = productRecipe('assessment-phase-deliverable.json')
    // The model lets the estimate slip into the next steps too: the gate keeps it out.
    const leak = said(
      `La fase successiva richiede ${EFFORT}.`,
      [at(ESTIMATE.fileName)],
      'fact',
      'estimates',
    )
    const { gathered: g, doc } = draft(recipe, 'passed_with_reservations', {
      next_steps_text: [said('Si propone di avviare la fase di analisi.', [], 'suggestion'), leak],
    })
    expect(failedChecks(recipe, g, doc)).toEqual([])
    const internalText = JSON.stringify(doc)
    expect(internalText).toContain(EFFORT)

    const { version, report } = projectClientVersion(doc, audience(recipe, g))
    const client = version.document
    expect(client.sections.map((s) => s.id)).toEqual([
      'objectives',
      'activities',
      'results',
      'risks',
      'gate_outcome',
      'gate',
      'next_steps',
    ])
    const clientText = JSON.stringify(client)
    for (const value of project.truth.internalValues) expect(clientText).not.toContain(value)
    for (const name of project.truth.internalFileNames) expect(clientText).not.toContain(name)
    expect(report.anomalies.map((a) => [a.code, a.ref.element])).toEqual([
      ['internal_data_in_client', 'segment'],
    ])
    // The outcome the PM proposed stays, under its fixed label.
    const outcome = blockValue(client, 'proposed_outcome_value')
    expect([outcome?.label, outcome?.cell.text]).toEqual(['Esito proposto', 'Superato con riserve'])
    expect(clientText).toContain("L'esito del gate è una proposta del PM")
    // The results keep their sources.
    const results = client.sections.find((s) => s.id === 'results')?.blocks[0]
    expect(results?.kind === 'text' && results.segments.every((s) => s.sources.length > 0)).toBe(
      true,
    )
  })

  it('the assessment never states a gate outcome decided by the model', () => {
    const recipe = productRecipe('assessment-phase-deliverable.json')
    // The outcome is a value the PM proposes: no slot of the gate can hold it.
    const gate = recipe.sections.find((s) => s.id === 'gate')
    const outcomeBlock = gate?.blocks.find((b) => b.id === 'proposed_outcome_value')
    expect(outcomeBlock).toMatchObject({
      kind: 'data_value',
      label: 'Esito proposto',
      compute: { op: 'parameter', parameter: 'proposed_outcome' },
    })
    // Skipped by the PM it stays «non dedotto», whatever the model writes.
    const skipped = draft(recipe, null)
    expect(skipped.doc.sections.find((s) => s.id === 'gate')?.notDeduced).toBe(false)
    expect(blockValue(skipped.doc, 'proposed_outcome_value')?.cell.text).toBeNull()

    // A text that states the outcome is an anomaly, wherever the model writes it.
    const inventory = phase.results[0]?.source ?? ''
    const stated = draft(recipe, 'passed', {
      gate_rationale: [said('Il gate è superato: tutti i sistemi sono elencati.', [at(inventory)])],
      results_text: [said('Gate superato con tutti i sistemi censiti.', [at(inventory)])],
    })
    expect(failedChecks(recipe, stated.gathered, stated.doc)).toEqual([
      ['outcome_only_proposed_gate', 'recipe_check_failed', 'form'],
      ['outcome_only_proposed_results', 'recipe_check_failed', 'form'],
    ])
    // Every result keeps its source: one without is an anomaly of data.
    const unsourced = draft(recipe, 'passed', {
      results_text: [said('Le criticità sono tutte risolte.', [])],
    })
    expect(failedChecks(recipe, unsourced.gathered, unsourced.doc)).toEqual([
      ['results_sourced', 'recipe_check_failed', 'data'],
    ])
  })

  it('the phase deliverable shows the gate outcome', () => {
    const recipe = productRecipe('assessment-phase-deliverable.json')
    // The library version the assessment playbook pins: still of both versions.
    expect([recipe.version, recipe.audience]).toEqual(['1.1.0', 'both'])
    const checklist: Checklist = phase.gate.criteria.map((item, i) => ({
      item,
      outcome: i === 0 ? 'Soddisfatta' : 'In parte',
    }))
    const { gathered: g, doc } = draft(recipe, 'passed_with_reservations', {}, checklist)
    expect(failedChecks(recipe, g, doc)).toEqual([])

    const { version } = projectClientVersion(doc, audience(recipe, g))
    for (const d of [doc, version.document]) {
      const ids = d.sections.map((s) => s.id)
      // The checklist of the gate comes before the outcome the PM proposes.
      expect(ids.indexOf('gate_outcome')).toBe(ids.indexOf('gate') - 1)
      const section = d.sections.find((s) => s.id === 'gate_outcome')
      // Two sections on the gate, never confused: the checklist and the PM's proposal.
      expect(section?.title).toBe('Esito del gate: checklist della fase')
      expect(d.sections.find((s) => s.id === 'gate')?.title).toBe('Esito del gate: proposta del PM')
      const table = section?.blocks.find((b) => b.id === 'gate_checklist_table')
      if (table?.kind !== 'table') throw new Error('the checklist is not a table')
      // Every item with the outcome the PM gave it, cited as typed by the PM.
      expect(table.rows.map((r) => r.cells.map((c) => c.text))).toEqual(
        checklist.map((c) => [c.item, c.outcome]),
      )
      expect(table.rows.every((r) => r.cells.every((c) => c.sources.length > 0))).toBe(true)
      expect(blockValue(d, 'proposed_outcome_value')?.cell.text).toBe('Superato con riserve')
    }

    // Without a checklist the section stays, and its table is «non dedotto», never invented.
    const skipped = draft(recipe, null)
    const table = skipped.doc.sections
      .find((s) => s.id === 'gate_outcome')
      ?.blocks.find((b) => b.id === 'gate_checklist_table')
    expect(table?.kind === 'table' && table.notDeduced).toBe(true)
  })

  it('asks at most five items for the checklist of the gate, each with its outcome', () => {
    const recipe = productRecipe('assessment-phase-deliverable.json')
    const p = recipe.parameters.find((x) => x.id === 'gate_checklist')
    if (p?.type !== 'rows') throw new Error('no checklist of the gate')
    expect(p.maxRows).toBe(5)
    expect(p.required).toBe(false)
    expect(p.columns.map((c) => c.id)).toEqual(['item', 'outcome'])
  })
})
