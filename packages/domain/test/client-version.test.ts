import { describe, expect, it } from 'vitest'
import {
  type AudienceAnomaly,
  acceptAnomaly,
  acceptanceRefusalText,
  audienceFindingText,
  type ClientVersion,
  checkAudience,
  clientPolicy,
  DomainError,
  documentSchema,
  fillTitle,
  isInternalOnly,
  projectClientVersion,
  rowKeyOf,
  sourceRefCategories,
} from '../src/recipe/index.ts'
import {
  AS_OF,
  audienceContext,
  DWSI_TITLE,
  INTERNAL_NOTE,
  internalDocument,
  recipeOf,
} from './support/client-version.ts'
import { sampleRecipe } from './support/recipes.ts'

type Raw = Record<string, unknown> & { blocks: Array<Record<string, unknown>> }

/** A recipe with one more section for the client, made of the given blocks. */
function recipeWithSection(version: 'both' | 'client', blocks: Array<Record<string, unknown>>) {
  const raw = sampleRecipe()
  raw.sections.push({
    id: 'extra',
    title: 'Dettaglio',
    required: false,
    version,
    removable: true,
    blocks,
  } as Raw)
  return raw
}

const timesheetTable = {
  kind: 'data_table',
  id: 'effort',
  title: 'Impegno',
  query: { kind: 'system_rows', view: 'v_timesheet_all' },
  columns: [
    {
      id: 'task',
      title: 'Attività',
      from: { kind: 'field', field: 'casetaskevent' },
      category: 'hours',
    },
    {
      id: 'rate',
      title: 'Costo orario',
      from: { kind: 'field', field: 'laborcosthh_new' },
      category: 'rates',
    },
  ],
}

function withEffortTable() {
  const doc = internalDocument()
  doc.sections.push({
    id: 'extra',
    title: 'Dettaglio',
    version: 'both',
    notDeduced: false,
    blocks: [
      {
        kind: 'table',
        id: 'effort',
        title: 'Impegno',
        notDeduced: false,
        columns: [
          { id: 'task', title: 'Attività', category: 'hours' },
          { id: 'rate', title: 'Costo orario', category: 'rates' },
        ],
        rows: [
          {
            key: 'r1',
            cells: [
              { text: 'Analisi', category: 'hours', operandCategories: ['hours'], sources: [4] },
              { text: '55,00 €', category: 'rates', operandCategories: ['rates'], sources: [4] },
            ],
          },
        ],
      },
    ],
  })
  return doc
}

const textOf = (v: ClientVersion) => JSON.stringify(v.document)

function blockOf(v: ClientVersion, id: string) {
  for (const s of v.document.sections) {
    const b = s.blocks.find((x) => x.id === id)
    if (b) return b
  }
  return undefined
}

function anomalyAt(anomalies: AudienceAnomaly[], element: string, id?: string) {
  return anomalies.find(
    (a) =>
      a.ref.element === element &&
      (id === undefined ||
        ('column' in a.ref && a.ref.column === id) ||
        ('block' in a.ref && a.ref.block === id)),
  )
}

const segmentAnomaly = (anomalies: AudienceAnomaly[]) =>
  anomalies.find((a) => a.ref.element === 'segment')

function inconsistency(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return undefined
}

describe('client version', () => {
  it('a work item of an internal tracker in a client version is an anomaly the PM may accept', () => {
    const keys = (r: AudienceAnomaly[]) =>
      new Set(r.filter((a) => a.internalSource).map((a) => a.refKey))
    // The client's tracker: only the internal evidence of the document is internal.
    const client = keys(
      projectClientVersion(internalDocument(), audienceContext()).report.anomalies,
    )
    const { trackers: _client, ...unsaid } = audienceContext()
    for (const ctx of [{ ...unsaid, trackers: { ado: 'internal' as const } }, unsaid]) {
      const { report } = projectClientVersion(internalDocument(), ctx)
      const added = report.anomalies.filter((a) => a.internalSource && !client.has(a.refKey))
      // An internal tracker, or one the PM never said is the client's: never a silent datum.
      expect(added.length).toBeGreaterThan(0)
      expect(added.every((a) => a.code === 'internal_data_in_client' && a.acceptable)).toBe(true)
    }
  })

  it('drops internal notes from the client version', () => {
    const { version } = projectClientVersion(internalDocument(), audienceContext())
    expect(version.document.audience).toBe('client')
    expect(version.document.internalNotes).toEqual([])
    expect(textOf(version)).not.toContain(INTERNAL_NOTE)
    expect(documentSchema.safeParse(version.document).success).toBe(true)
  })

  it('drops the internal sections, so the team hours never reach the client', () => {
    const { version } = projectClientVersion(internalDocument(), audienceContext())
    expect(version.document.sections.map((s) => s.id)).toEqual(['order', 'summary', 'progress'])
    expect(textOf(version)).not.toContain('Ore lavorate')
  })

  it('flags a rate in a client table even when the PM reclassified the export', () => {
    const recipe = recipeOf(recipeWithSection('both', [timesheetTable]))
    const base = audienceContext(recipe)
    // The PM made the uploaded export a generic document for the client.
    const ctx = {
      ...base,
      evidence: {
        ...base.evidence,
        'ev-dwsi': {
          kind: 'generic' as const,
          audience: 'client' as const,
          fromSystem: false,
          title: DWSI_TITLE,
        },
      },
    }
    const { version, report } = projectClientVersion(withEffortTable(), ctx)
    const rate = anomalyAt(report.anomalies, 'column', 'rate')
    expect(rate).toMatchObject({
      code: 'internal_data_in_client',
      class: 'data',
      gate: 5,
      acceptable: true,
      status: 'open',
    })
    expect(rate?.categories).toContain('rates')
    // Hours from system data are internal too.
    expect(anomalyAt(report.anomalies, 'column', 'task')?.categories).toContain('hours')
    // Withheld while the anomaly is open.
    expect(blockOf(version, 'effort')).toBeUndefined()
    expect(textOf(version)).not.toContain('55,00')
  })

  it('lets invoiced amounts from the data warehouse through the client projection', () => {
    const { version, report } = projectClientVersion(internalDocument(), audienceContext())
    const positions = blockOf(version, 'positions')
    expect(positions?.kind).toBe('table')
    if (positions?.kind !== 'table') return
    expect(positions.columns.map((c) => c.id)).toEqual([
      'line',
      'item',
      'amount',
      'invoiced',
      'remaining',
      'date',
    ])
    expect(positions.rows[0]?.cells.map((c) => c.text)).toContain('8.000,00 €')
    expect(anomalyAt(report.anomalies, 'column')).toBeUndefined()
    expect(anomalyAt(report.anomalies, 'value')).toBeUndefined()
    expect(textOf(version)).toContain("Fatturati 8.000,00 € sui 12.000,00 € dell'ordine.")
  })

  it('keeps the data warehouse extraction internal as a document', () => {
    const ctx = audienceContext()
    const before = structuredClone(ctx.evidence)
    const { version, report } = projectClientVersion(internalDocument(), ctx)
    expect(isInternalOnly('economics_export', true)).toBe(true)
    expect(ctx.evidence).toEqual(before)
    // The text taken from the extraction is internal data: out of the file, as an anomaly.
    const fromExtraction = segmentAnomaly(report.anomalies)
    expect(fromExtraction?.categories).toEqual(expect.arrayContaining(['margins', 'personal']))
    expect(textOf(version)).not.toContain('18%')
    expect(textOf(version)).not.toContain(DWSI_TITLE)
    // A reclassification by the PM does not open the extraction itself.
    const reclassified = {
      ...ctx,
      evidence: {
        'ev-dwsi': {
          kind: 'economics_export' as const,
          audience: 'client' as const,
          fromSystem: false,
          title: DWSI_TITLE,
        },
      },
    }
    expect(
      sourceRefCategories(
        { kind: 'evidence', evidenceId: 'ev-dwsi', locator: { kind: 'page', page: 1 } },
        reclassified,
      ),
    ).toEqual(['personal'])
  })

  it('writes a generic source note, never an internal title, in the client version', () => {
    const { version } = projectClientVersion(internalDocument(), audienceContext())
    const labels = version.document.sourceNotes.map((n) => n.label)
    expect(labels).toEqual([
      'Sistema amministrativo, dati al 05/11/2026',
      'Backlog di progetto, aggiornato al 06/11/2026',
    ])
    for (const n of version.document.sourceNotes) expect(n).not.toHaveProperty('ref')
    expect(textOf(version)).not.toContain('Ordine 4711')
    expect(textOf(version)).not.toContain('Fatturazione elettronica')
    // The internal version keeps its titles.
    expect(internalDocument().sourceNotes[0]?.label).toBe('Ordine 4711, riga 1')

    // The gate checks the format: a client version with an internal title is refused.
    const forged = structuredClone(version)
    const first = forged.document.sourceNotes[0]
    if (first) first.label = DWSI_TITLE
    const report = checkAudience(forged, audienceContext(), internalDocument())
    const note = report.anomalies.find((a) => a.code === 'client_source_note_not_generic')
    expect(note).toMatchObject({ acceptable: false, status: 'open' })
  })

  it('gives one note per class and day, the oldest instant standing for it', () => {
    const doc = internalDocument()
    doc.sourceNotes.push({
      n: 5,
      label: 'Ordine 4711, riga 2',
      dataAsOf: '2026-11-05T06:00:00.000Z',
      ref: {
        kind: 'system_row',
        sourceId: 'dwsi',
        view: 'v_sales_order_all',
        key: [{ column: 'lineid', value: '2' }],
        columns: ['amount', 'invoiced', 'lineid', 'salesorderdate', 'status'],
      },
    })
    const positions = doc.sections[0]?.blocks[0]
    if (positions?.kind === 'table') {
      for (const c of positions.rows[0]?.cells ?? []) c.sources = [1, 5]
    }
    const { version } = projectClientVersion(doc, audienceContext())
    expect(version.document.sourceNotes[0]).toEqual({
      n: 1,
      label: 'Sistema amministrativo, dati al 05/11/2026',
      dataAsOf: '2026-11-05T06:00:00.000Z',
    })
    expect(version.notes[0]?.refs).toHaveLength(2)
    const projected = blockOf(version, 'positions')
    if (projected?.kind === 'table') expect(projected.rows[0]?.cells[0]?.sources).toEqual([1])
  })

  it('lets the PM accept an internal-data anomaly with a reason, and never a credential', () => {
    const ctx = audienceContext()
    const first = projectClientVersion(internalDocument(), ctx)
    const anomaly = segmentAnomaly(first.report.anomalies)
    if (!anomaly) throw new Error('expected an anomaly on the text from the extraction')

    expect(acceptAnomaly(anomaly, { reason: 'va bene', by: 'pm-1', at: AS_OF })).toEqual({
      ok: false,
      refusal: 'reason_too_short',
    })
    const accepted = acceptAnomaly(anomaly, {
      reason: 'Il cliente ha chiesto di vedere la marginalità del mese.',
      by: 'pm-1',
      at: AS_OF,
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return

    const again = projectClientVersion(internalDocument(), ctx, [accepted.acceptance])
    expect(segmentAnomaly(again.report.anomalies)?.status).toBe('accepted')
    expect(textOf(again.version)).toContain('18%')
    // The re-check before the render sees the accepted content and nothing open.
    const recheck = checkAudience(again.version, ctx, internalDocument(), [accepted.acceptance])
    expect(recheck.anomalies.filter((a) => a.status === 'open')).toEqual([])

    // The acceptance holds only for that content.
    const changed = internalDocument()
    const summary = changed.sections[1]?.blocks[1]
    if (summary?.kind === 'text' && summary.segments[1])
      summary.segments[1].sourceCategories = ['costs']
    const third = projectClientVersion(changed, ctx, [accepted.acceptance])
    expect(segmentAnomaly(third.report.anomalies)?.status).toBe('open')
    expect(textOf(third.version)).not.toContain('18%')

    // Credentials and secrets are never accepted, whatever the anomaly says of itself.
    const credential = {
      code: 'credential_in_text',
      refKey: anomaly.refKey,
      contentHash: anomaly.contentHash,
      acceptable: true,
    }
    expect(
      acceptAnomaly(credential, {
        reason: 'È una password di prova, la lascio così.',
        by: 'pm-1',
        at: AS_OF,
      }),
    ).toEqual({ ok: false, refusal: 'not_acceptable' })
    expect(acceptanceRefusalText('not_acceptable', 'it')).toMatch(/credenziali/)
  })

  it('never lets an internal note or an internal section be accepted', () => {
    const { version } = projectClientVersion(internalDocument(), audienceContext())
    const forged = structuredClone(version) as ClientVersion & {
      document: { internalNotes: unknown[] }
    }
    forged.document.internalNotes = internalDocument().internalNotes
    const team = internalDocument().sections[3]
    if (team) forged.document.sections.push(team)
    const report = checkAudience(forged, audienceContext(), internalDocument())
    const codes = report.anomalies.map((a) => a.code)
    expect(codes).toContain('internal_note_in_client')
    expect(codes).toContain('internal_section_in_client')
    for (const a of report.anomalies.filter((x) => x.code !== 'internal_data_in_client')) {
      expect(a.acceptable).toBe(false)
      expect(
        acceptAnomaly(a, {
          reason: 'La nota serve anche al cliente, va bene così.',
          by: 'pm',
          at: AS_OF,
        }),
      ).toEqual({ ok: false, refusal: 'not_acceptable' })
    }
  })

  it('gives only a warning, not an anomaly, for story points in a client version', () => {
    const { version, report } = projectClientVersion(internalDocument(), audienceContext())
    const warning = report.warnings.find(
      (w) => w.ref.element === 'column' && w.ref.column === 'points',
    )
    expect(warning).toMatchObject({ code: 'story_points_in_client', requiresConfirmation: true })
    expect(anomalyAt(report.anomalies, 'column', 'points')).toBeUndefined()
    const features = blockOf(version, 'features')
    if (features?.kind === 'table') expect(features.columns.map((c) => c.id)).toContain('points')
  })

  it('does not count story points as estimates, and follows the PM reclassifying them', () => {
    // Named in a text: still only a warning.
    const doc = internalDocument()
    const summary = doc.sections[1]?.blocks[1]
    if (summary?.kind === 'text') {
      summary.segments.push({
        text: 'Chiusi tutti gli story point previsti.',
        nature: 'inference',
        category: 'other',
        sources: [],
        sourceCategories: [],
      })
    }
    const named = projectClientVersion(doc, audienceContext())
    expect(named.report.warnings.some((w) => w.ref.element === 'segment')).toBe(true)
    expect(named.report.anomalies.filter((a) => a.categories.includes('estimates'))).toEqual([])

    // The PM raised the column to estimates: then it is internal data.
    const raw = sampleRecipe()
    raw.extraInternalCategories = [{ block: 'features', column: 'points', category: 'estimates' }]
    const reclassified = internalDocument()
    const features = reclassified.sections[2]?.blocks[0]
    if (features?.kind === 'table') {
      for (const r of features.rows) {
        const points = r.cells[2]
        if (points) points.operandCategories = ['estimates']
      }
    }
    const raised = projectClientVersion(reclassified, audienceContext(recipeOf(raw)))
    expect(anomalyAt(raised.report.anomalies, 'column', 'points')?.categories).toEqual([
      'estimates',
    ])
  })

  it('an Admin cannot widen the client-safe categories', () => {
    for (const widened of [['other', 'costs'], ['story_points'], ['margins'], ['nonsense']]) {
      expect(inconsistency(() => clientPolicy(widened))).toBe('client_categories_widened')
    }
    expect(clientPolicy().allowed).toEqual(['contract_amounts', 'invoiced_amounts', 'other'])

    // Restricting holds: without invoiced amounts the invoiced column is internal data.
    const ctx = { ...audienceContext(), policy: clientPolicy(['contract_amounts', 'other']) }
    const { report } = projectClientVersion(internalDocument(), ctx)
    expect(anomalyAt(report.anomalies, 'column', 'invoiced')?.categories).toEqual([
      'invoiced_amounts',
    ])
    expect(anomalyAt(report.anomalies, 'column', 'remaining')?.categories).toEqual([
      'invoiced_amounts',
    ])
    expect(anomalyAt(report.anomalies, 'column', 'amount')).toBeUndefined()
  })

  it('finds the words of the organization in a text without internal sources', () => {
    const doc = internalDocument()
    const summary = doc.sections[1]?.blocks[1]
    if (summary?.kind === 'text') {
      summary.segments.push({
        text: 'La tariffa giornaliera resta quella di settembre.',
        nature: 'inference',
        category: 'other',
        sources: [],
        sourceCategories: [],
      })
    }
    const { version, report } = projectClientVersion(doc, audienceContext())
    const found = report.anomalies.find((a) => a.terms.includes('tariffa'))
    expect(found?.categories).toEqual(['rates'])
    expect(textOf(version)).not.toContain('tariffa giornaliera')
    // A word that only contains one of the terms is not found.
    expect(textOf(version)).toContain('La consegna resta prevista')
  })

  it('admits by the categories it recomputes, never by those the document declares', () => {
    // A rate column declared as project data in the document: refused.
    const recipe = recipeOf(recipeWithSection('both', [timesheetTable]))
    const doc = withEffortTable()
    const effort = doc.sections[4]?.blocks[0]
    if (effort?.kind === 'table' && effort.rows[0]?.cells[1]) {
      effort.rows[0].cells[1].operandCategories = ['other']
      effort.rows[0].cells[1].category = 'other'
    }
    expect(inconsistency(() => projectClientVersion(doc, audienceContext(recipe)))).toBe(
      'client_version_inconsistent',
    )

    // A text citing the story points of a work item, declared as project data: refused.
    const text = internalDocument()
    const feature = text.sourceNotes[1]
    if (feature?.ref.kind === 'work_item') feature.ref.field = 'story_points'
    const summary = text.sections[1]?.blocks[1]
    if (summary?.kind === 'text' && summary.segments[2]) {
      summary.segments[2].sources = [2]
      summary.segments[2].sourceCategories = ['other']
    }
    expect(inconsistency(() => projectClientVersion(text, audienceContext()))).toBe(
      'client_version_inconsistent',
    )

    // A text from the extraction declared as project data: admitted as internal all the same.
    const extraction = internalDocument()
    const block = extraction.sections[1]?.blocks[1]
    if (block?.kind === 'text' && block.segments[1]) {
      block.segments[1].sourceCategories = ['other']
      block.segments[1].category = 'other'
    }
    const { report } = projectClientVersion(extraction, audienceContext())
    expect(segmentAnomaly(report.anomalies)).toMatchObject({
      internalSource: true,
      categories: ['personal'],
    })

    // A computed residual that forgets one of its operands: refused.
    const residual = internalDocument()
    const positions = residual.sections[0]?.blocks[0]
    if (positions?.kind === 'table' && positions.rows[0]?.cells[4]) {
      positions.rows[0].cells[4].operandCategories = ['contract_amounts']
    }
    expect(inconsistency(() => projectClientVersion(residual, audienceContext()))).toBe(
      'client_version_inconsistent',
    )
  })

  it('refuses a version that does not match its recipe or its sources', () => {
    const cases: Array<(d: ReturnType<typeof internalDocument>) => void> = [
      (d) => {
        d.recipe.version = '2.0.0'
      },
      (d) => {
        const s = d.sections[1]?.blocks[0]
        if (s?.kind === 'static') s.text = 'Il costo del mese è di 3.000 €.'
      },
      (d) => {
        const p = d.sections[0]?.blocks[0]
        if (p?.kind === 'table' && p.columns[1]) p.columns[1].id = 'rate'
      },
      (d) => {
        const p = d.sections[0]?.blocks[0]
        if (p?.kind === 'table' && p.rows[0]) p.rows[0].cells.pop()
      },
      (d) => {
        const p = d.sections[0]?.blocks[0]
        // A cell of the sales order table citing a row of the timesheet.
        if (p?.kind === 'table' && p.rows[0]?.cells[0]) p.rows[0].cells[0].sources = [4]
      },
      (d) => {
        const n = d.sourceNotes[2]
        if (n?.ref.kind === 'evidence') n.ref.evidenceId = 'ev-unknown'
      },
      (d) => {
        if (d.sections[0]) d.sections[0].id = 'unknown_section'
      },
      (d) => {
        const p = d.sections[0]?.blocks[0]
        if (p) p.id = 'features'
      },
    ]
    for (const change of cases) {
      const doc = internalDocument()
      change(doc)
      expect(inconsistency(() => projectClientVersion(doc, audienceContext()))).toBe(
        'client_version_inconsistent',
      )
    }
    const client = projectClientVersion(internalDocument(), audienceContext()).version
    expect(
      inconsistency(() => projectClientVersion(client.document as never, audienceContext())),
    ).toBe('client_version_inconsistent')
    expect(
      inconsistency(() =>
        checkAudience(
          { ...client, notes: client.notes.slice(1) },
          audienceContext(),
          internalDocument(),
        ),
      ),
    ).toBe('client_version_inconsistent')
    expect(
      inconsistency(() =>
        checkAudience(
          { document: internalDocument() as never, notes: client.notes, values: client.values },
          audienceContext(),
          internalDocument(),
        ),
      ),
    ).toBe('client_version_inconsistent')
  })

  it('refuses a recipe that produces only the internal version', () => {
    const raw = sampleRecipe()
    raw.audience = 'internal'
    raw.sections = raw.sections.filter((s) => s.version !== 'client')
    raw.checks = []
    raw.render = { formats: ['md'], template: null, sections: [], namedCells: [] }
    const recipe = recipeOf(raw)
    expect(
      inconsistency(() => projectClientVersion(internalDocument(), audienceContext(recipe))),
    ).toBe('recipe_not_for_client')
  })

  it('withholds a withheld column without leaving its notes behind', () => {
    const recipe = recipeOf(recipeWithSection('both', [timesheetTable]))
    const { version } = projectClientVersion(withEffortTable(), audienceContext(recipe))
    expect(
      version.notes
        .flatMap((t) => t.refs)
        .some((r) => r.kind === 'system_row' && r.view === 'v_timesheet_all'),
    ).toBe(false)
    expect(version.document.sourceNotes.map((n) => n.n)).toEqual([1, 2])
  })

  it('judges the sources a text cites by what they may hold', () => {
    const ctx = audienceContext()
    expect(
      sourceRefCategories(
        {
          kind: 'system_row',
          sourceId: 'dwsi',
          view: 'v_invoice_all',
          key: [{ column: 'a', value: '1' }],
        },
        ctx,
      ),
    ).toEqual(['invoiced_amounts', 'rates', 'other'])
    expect(
      sourceRefCategories(
        {
          kind: 'system_row',
          sourceId: 'dwsi',
          view: 'v_unknown',
          key: [{ column: 'a', value: '1' }],
        },
        ctx,
      ),
    ).toEqual(['personal'])
    expect(
      sourceRefCategories({ kind: 'work_item', sourceId: 'ado', id: '1', field: 'assignee' }, ctx),
    ).toEqual(['personal'])
    expect(
      sourceRefCategories(
        { kind: 'work_item', sourceId: 'ado', id: '1', field: 'story_points' },
        ctx,
      ),
    ).toEqual(['story_points'])
    expect(
      sourceRefCategories({ kind: 'work_item_counts', sourceId: 'ado', query: 'q' }, ctx),
    ).toEqual(['other'])
    expect(
      sourceRefCategories(
        { kind: 'evidence', evidenceId: 'ev-minutes', locator: { kind: 'page', page: 1 } },
        ctx,
      ),
    ).toEqual(['other'])
    expect(sourceRefCategories({ kind: 'fact', factId: 'fact-risk' }, ctx)).toEqual(['other'])
    expect(sourceRefCategories({ kind: 'fact', factId: 'fact-margin' }, ctx)).toEqual(['personal'])
    expect(sourceRefCategories({ kind: 'parameter', parameterId: 'note' }, ctx)).toEqual(['other'])
    expect(inconsistency(() => sourceRefCategories({ kind: 'fact', factId: 'nope' }, ctx))).toBe(
      'client_version_inconsistent',
    )
  })

  it('tells the PM where the internal data is and what it is, without identifiers', () => {
    const recipe = recipeOf(recipeWithSection('both', [timesheetTable]))
    const { report } = projectClientVersion(withEffortTable(), audienceContext(recipe))
    const rate = anomalyAt(report.anomalies, 'column', 'rate')
    if (!rate) throw new Error('expected the rate anomaly')
    expect(audienceFindingText(rate, 'it')).toBe(
      'Nella versione per il cliente la colonna “Costo orario” della tabella “Impegno” contiene tariffe: sono dati interni. Resta fuori dal file finché non lo accetti con «Accetta così», con una motivazione.',
    )
    const segment = segmentAnomaly(report.anomalies)
    if (!segment) throw new Error('expected the segment anomaly')
    expect(audienceFindingText(segment, 'it')).toContain(
      'un testo della sezione “Sintesi del periodo ottobre 2026” riprende una fonte interna e contiene margini: sono dati interni.',
    )
    const warning = report.warnings[0]
    if (!warning) throw new Error('expected the story points warning')
    expect(audienceFindingText(warning, 'it')).toContain('contiene story point')
    for (const a of [...report.anomalies, ...report.warnings]) {
      expect(audienceFindingText(a, 'it')).not.toMatch(/\{|\}|_|sha256/)
    }
  })

  it('admits lists of facts, computed shares and values typed by the PM', () => {
    const recipe = recipeOf(
      recipeWithSection('client', [
        {
          kind: 'data_list',
          id: 'risks',
          title: 'Rischi',
          query: { kind: 'facts', factKind: 'risk', audience: 'client' },
          columns: [
            {
              id: 'statement',
              title: 'Rischio',
              from: { kind: 'field', field: 'statement' },
              category: 'other',
            },
          ],
        },
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
          label: 'Numero della richiesta',
          compute: { op: 'parameter', parameter: 'request_number' },
          category: 'other',
        },
        {
          kind: 'data_value',
          id: 'risk_count',
          label: 'Rischi aperti',
          compute: { op: 'count', block: 'risks' },
          category: 'other',
        },
      ]),
    )
    const doc = internalDocument()
    doc.sourceNotes.push(
      {
        n: 5,
        label: 'Rischio sui tempi del collaudo',
        dataAsOf: null,
        ref: { kind: 'fact', factId: 'fact-risk' },
      },
      {
        n: 6,
        label: 'Indicato da te',
        dataAsOf: null,
        ref: { kind: 'parameter', parameterId: 'request_number' },
      },
    )
    const value = (
      id: string,
      label: string,
      text: string,
      category: string,
      operands: string[],
      sources: number[],
    ) => ({
      kind: 'value' as const,
      id,
      label,
      cell: { text, category, operandCategories: operands, sources },
    })
    doc.sections.push({
      id: 'extra',
      title: 'Dettaglio',
      version: 'client',
      notDeduced: false,
      blocks: [
        {
          kind: 'list',
          id: 'risks',
          title: 'Rischi',
          notDeduced: false,
          columns: [{ id: 'statement', title: 'Rischio', category: 'other' }],
          items: [
            {
              key: 'r1',
              cells: [
                {
                  text: 'Collaudo a rischio',
                  category: 'other',
                  operandCategories: ['other'],
                  sources: [5],
                },
              ],
            },
          ],
        },
        value(
          'invoiced_total',
          'Totale fatturato',
          '8.000,00 €',
          'invoiced_amounts',
          ['invoiced_amounts'],
          [1],
        ),
        value(
          'invoiced_share',
          'Quota fatturata',
          '67%',
          'invoiced_amounts',
          ['invoiced_amounts', 'contract_amounts'],
          [1],
        ),
        value('request', 'Numero della richiesta', '3', 'other', ['other'], [6]),
        value('risk_count', 'Rischi aperti', '1', 'other', ['other'], [5]),
      ],
    } as never)
    const { version, report } = projectClientVersion(doc, audienceContext(recipe))
    expect(report.anomalies).toEqual([segmentAnomaly(report.anomalies)])
    expect(blockOf(version, 'risks')?.kind).toBe('list')
    expect(blockOf(version, 'invoiced_share')?.kind).toBe('value')
    expect(version.document.sourceNotes.map((n) => n.label)).toEqual([
      'Sistema amministrativo, dati al 05/11/2026',
      'Backlog di progetto, aggiornato al 06/11/2026',
      'Conoscenza di progetto, data non indicata',
      'Indicato dal project manager',
    ])

    // A risk of internal sources is internal: the list is withheld.
    const internalFacts = audienceContext(recipe)
    const ctx = {
      ...internalFacts,
      facts: { ...internalFacts.facts, 'fact-risk': { kind: 'risk' as const, clientOnly: false } },
    }
    const internalRisk = projectClientVersion(doc, ctx)
    // The recipe asks for facts for the client only: what was read is checked again.
    expect(anomalyAt(internalRisk.report.anomalies, 'column', 'statement')).toMatchObject({
      internalSource: true,
      status: 'open',
    })
    expect(blockOf(internalRisk.version, 'risks')).toBeUndefined()
    // A value counted on those facts is checked on them too.
    expect(anomalyAt(internalRisk.report.anomalies, 'value', 'risk_count')).toMatchObject({
      internalSource: true,
      status: 'open',
    })
    expect(blockOf(internalRisk.version, 'risk_count')).toBeUndefined()

    // A value citing sources its computation does not read: refused.
    const stray = structuredClone(doc)
    const strayBlock = stray.sections[4]?.blocks.find((b) => b.id === 'request')
    if (strayBlock?.kind === 'value') strayBlock.cell.sources = [4]
    expect(inconsistency(() => projectClientVersion(stray, audienceContext(recipe)))).toBe(
      'client_version_inconsistent',
    )
    const total = internalDocument()
    const totalBlock = total.sections[0]?.blocks[1]
    if (totalBlock?.kind === 'value') totalBlock.cell.sources = [3]
    expect(inconsistency(() => projectClientVersion(total, audienceContext()))).toBe(
      'client_version_inconsistent',
    )

    // A value from an internal column is internal whatever the document says.
    const hoursValue = recipeOf(
      recipeWithSection('both', [
        timesheetTable,
        {
          kind: 'data_value',
          id: 'top_rate',
          label: 'Tariffa più alta',
          compute: { op: 'max', column: { block: 'effort', column: 'rate' } },
          category: 'rates',
        },
      ]),
    )
    const withValue = withEffortTable()
    withValue.sections[4]?.blocks.push(
      value('top_rate', 'Tariffa più alta', '55,00 €', 'rates', ['rates'], [4]) as never,
    )
    const top = projectClientVersion(withValue, audienceContext(hoursValue))
    expect(anomalyAt(top.report.anomalies, 'value', 'top_rate')?.categories).toEqual(['rates'])
    expect(blockOf(top.version, 'top_rate')).toBeUndefined()
  })

  it('never carries a withheld key column into the client version through the row key', () => {
    const recipe = recipeOf(
      recipeWithSection('both', [
        {
          kind: 'data_table',
          id: 'staff',
          title: 'Persone',
          query: { kind: 'system_rows', view: 'v_timesheet_all' },
          key: ['employee'],
          columns: [
            {
              id: 'project',
              title: 'Progetto',
              from: { kind: 'field', field: 'projectid' },
              category: 'other',
            },
            {
              id: 'employee',
              title: 'Persona',
              from: { kind: 'field', field: 'employee' },
              category: 'personal',
            },
          ],
        },
      ]),
    )
    const doc = internalDocument()
    doc.sections.push({
      id: 'extra',
      title: 'Dettaglio',
      version: 'both',
      notDeduced: false,
      blocks: [
        {
          kind: 'table',
          id: 'staff',
          title: 'Persone',
          notDeduced: false,
          columns: [
            { id: 'project', title: 'Progetto', category: 'other' },
            { id: 'employee', title: 'Persona', category: 'personal' },
          ],
          rows: [
            {
              key: 'Mario Rossi',
              cells: [
                { text: 'P-1', category: 'other', operandCategories: ['other'], sources: [4] },
                {
                  text: 'Mario Rossi',
                  category: 'personal',
                  operandCategories: ['personal'],
                  sources: [4],
                },
              ],
            },
          ],
        },
      ],
    } as never)
    const ctx = audienceContext(recipe)
    const { version, report } = projectClientVersion(doc, ctx)
    const staff = blockOf(version, 'staff')
    if (staff?.kind !== 'table') throw new Error('expected the staff table')
    expect(staff.columns.map((c) => c.id)).toEqual(['project'])
    expect(staff.rows.map((r) => r.key)).toEqual(['1'])
    expect(textOf(version)).not.toContain('Mario Rossi')
    // Rows of a table without key columns never keep their key either.
    const features = blockOf(version, 'features')
    if (features?.kind === 'table') expect(features.rows.map((r) => r.key)).toEqual(['1'])
    // The re-check agrees, and a forged key is refused.
    expect(checkAudience(version, ctx, doc).anomalies.filter((a) => a.status === 'open')).toEqual(
      [],
    )
    const forged = structuredClone(version)
    const forgedStaff = forged.document.sections
      .flatMap((s) => s.blocks)
      .find((b) => b.id === 'staff')
    if (forgedStaff?.kind === 'table' && forgedStaff.rows[0])
      forgedStaff.rows[0].key = 'Mario Rossi'
    expect(inconsistency(() => checkAudience(forged, ctx, doc))).toBe('client_version_inconsistent')

    // Accepted, the key column comes back with its key; the other column stays accepted.
    const employee = anomalyAt(report.anomalies, 'column', 'employee')
    if (!employee) throw new Error('expected the employee anomaly')
    const accepted = acceptAnomaly(employee, {
      reason: 'Il cliente conosce il referente e lo ha chiesto.',
      by: 'pm-1',
      at: AS_OF,
    })
    if (!accepted.ok) throw new Error('expected an acceptance')
    const again = projectClientVersion(doc, ctx, [accepted.acceptance])
    const back = blockOf(again.version, 'staff')
    if (back?.kind === 'table') expect(back.rows.map((r) => r.key)).toEqual(['["Mario Rossi"]'])
    // The internal key never reaches the client: the key is made of the key cells shown.
    const lying = structuredClone(doc)
    const lyingStaff = lying.sections[4]?.blocks[0]
    if (lyingStaff?.kind === 'table' && lyingStaff.rows[0]) {
      lyingStaff.rows[0].key = 'Mario Rossi, 55,00 € orari'
    }
    const lyingVersion = projectClientVersion(lying, ctx, [accepted.acceptance]).version
    expect(textOf(lyingVersion)).not.toContain('55,00')
    // A changed key cell is a changed content: the acceptance no longer holds.
    const named = structuredClone(doc)
    const namedStaff = named.sections[4]?.blocks[0]
    if (namedStaff?.kind === 'table' && namedStaff.rows[0]?.cells[1]) {
      namedStaff.rows[0].cells[1].text = 'tariffa senior'
    }
    const namedRun = projectClientVersion(named, ctx, [accepted.acceptance])
    expect(anomalyAt(namedRun.report.anomalies, 'column', 'employee')).toMatchObject({
      status: 'open',
      terms: ['tariffa'],
    })
    expect(anomalyAt(namedRun.report.anomalies, 'column', 'project')).toBeUndefined()
    expect(textOf(namedRun.version)).not.toContain('tariffa senior')
  })

  it('never carries a key that differs from its key cells into the client version', () => {
    const doc = internalDocument()
    const positions = doc.sections[0]?.blocks[0]
    if (positions?.kind === 'table' && positions.rows[0]) {
      positions.rows[0].key = 'riga 1, costo interno 9.840 €'
    }
    const ctx = audienceContext()
    const { version } = projectClientVersion(doc, ctx)
    const projected = blockOf(version, 'positions')
    if (projected?.kind !== 'table') throw new Error('expected the positions table')
    expect(projected.rows.map((r) => r.key)).toEqual([rowKeyOf(['1'])])
    expect(textOf(version)).not.toContain('9.840')
    // The gate refuses a key that is not made of the key cells.
    const forged = structuredClone(version)
    const table = forged.document.sections[0]?.blocks[0]
    if (table?.kind === 'table' && table.rows[0]) table.rows[0].key = 'riga 1, costo interno'
    expect(inconsistency(() => checkAudience(forged, ctx, doc))).toBe('client_version_inconsistent')
    // An empty key cell gives the position.
    const empty = internalDocument()
    const emptyTable = empty.sections[0]?.blocks[0]
    if (emptyTable?.kind === 'table' && emptyTable.rows[0]?.cells[0]) {
      emptyTable.rows[0].cells[0].text = null
    }
    const emptyVersion = projectClientVersion(empty, ctx).version
    const emptyProjected = blockOf(emptyVersion, 'positions')
    if (emptyProjected?.kind === 'table') expect(emptyProjected.rows[0]?.key).toBe('1')
    expect(rowKeyOf([])).toBeNull()
    expect(rowKeyOf(['a', null])).toBeNull()
    expect(rowKeyOf(['x'.repeat(1_200)])).toMatch(/^sha256:/)
  })

  it('judges a key column by its category even when its cells are empty', () => {
    const recipe = recipeOf(
      recipeWithSection('both', [
        {
          kind: 'data_table',
          id: 'rk',
          title: 'Righe',
          query: { kind: 'system_rows', view: 'v_timesheet_all' },
          key: ['rate'],
          columns: [
            {
              id: 'project',
              title: 'Progetto',
              from: { kind: 'field', field: 'projectid' },
              category: 'other',
            },
            {
              id: 'rate',
              title: 'Valore',
              from: { kind: 'field', field: 'laborcosthh_new' },
              category: 'rates',
            },
          ],
        },
      ]),
    )
    const doc = internalDocument()
    doc.sections.push({
      id: 'extra',
      title: 'Dettaglio',
      version: 'both',
      notDeduced: false,
      blocks: [
        {
          kind: 'table',
          id: 'rk',
          title: 'Righe',
          notDeduced: false,
          columns: [
            { id: 'project', title: 'Progetto', category: 'other' },
            { id: 'rate', title: 'Valore', category: 'rates' },
          ],
          rows: [
            {
              key: '55,00 €/h',
              cells: [
                { text: 'P-1', category: 'other', operandCategories: ['other'], sources: [4] },
                { text: null, category: 'rates', operandCategories: ['rates'], sources: [4] },
              ],
            },
          ],
        },
      ],
    } as never)
    const { version, report } = projectClientVersion(doc, audienceContext(recipe))
    expect(anomalyAt(report.anomalies, 'column', 'rate')?.categories).toEqual(['rates'])
    const rk = blockOf(version, 'rk')
    if (rk?.kind !== 'table') throw new Error('expected the table')
    expect(rk.columns.map((c) => c.id)).toEqual(['project'])
    expect(rk.rows.map((r) => r.key)).toEqual(['1'])
    expect(textOf(version)).not.toContain('55,00')
  })

  it('refuses titles that are not the recipe titles with the values of the parameters', () => {
    const ctx = audienceContext()
    const cases: Array<(d: ReturnType<typeof internalDocument>) => void> = [
      (d) => {
        d.title = 'SAL 18% sul venduto'
      },
      (d) => {
        if (d.sections[1]) d.sections[1].title = 'Sintesi: margine al 18%'
      },
      (d) => {
        const b = d.sections[0]?.blocks[0]
        if (b?.kind === 'table') b.title = 'Posizioni (ricavo meno 9.840 € interni)'
      },
      (d) => {
        const b = d.sections[1]?.blocks[1]
        if (b?.kind === 'text') b.title = 'Nota: 650 € al giorno per il senior'
      },
      (d) => {
        d.recipe.title = 'SAL interno'
      },
    ]
    for (const change of cases) {
      const doc = internalDocument()
      change(doc)
      expect(inconsistency(() => projectClientVersion(doc, ctx))).toBe(
        'client_version_inconsistent',
      )
    }
    expect(fillTitle('Sintesi del periodo {{period}}', {}, 'it')).toBe(
      'Sintesi del periodo non dedotto',
    )
  })

  it('flags words in other alphabets, also split by invisible characters, in texts and cells', () => {
    const texts = [
      'Il c\u200b\u043e\u200bsto orario resta stabile.',
      'Il \u0421\u041e\u0405\u0422\u041e orario resta stabile.',
      'Il c\u0585sto orario resta stabile.',
    ]
    for (const text of texts) {
      const doc = internalDocument()
      const summary = doc.sections[1]?.blocks[1]
      if (summary?.kind === 'text') {
        summary.segments.push({
          text,
          nature: 'inference',
          category: 'other',
          sources: [],
          sourceCategories: [],
        })
      }
      const { version, report } = projectClientVersion(doc, audienceContext())
      const codes = report.anomalies.filter((a) => a.ref.element === 'segment').map((a) => a.code)
      expect(codes).toContain('mixed_script_in_client')
      expect(codes).toContain('internal_data_in_client')
      expect(textOf(version)).not.toContain('orario resta')
    }
    const cell = internalDocument()
    const positions = cell.sections[0]?.blocks[0]
    if (positions?.kind === 'table' && positions.rows[0]?.cells[1]) {
      positions.rows[0].cells[1].text = 'Analisi c\u200b\u043e\u200bsto 9.000'
    }
    const run = projectClientVersion(cell, audienceContext())
    expect(anomalyAt(run.report.anomalies, 'column', 'item')).toBeDefined()
    expect(textOf(run.version)).not.toContain('9.000')
  })

  it('gives rows with the same key cells their positions', () => {
    const recipe = recipeOf(
      recipeWithSection('both', [
        {
          kind: 'data_table',
          id: 'rk',
          title: 'Righe',
          query: { kind: 'system_rows', view: 'v_sales_order_all' },
          key: ['item'],
          columns: [
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
          ],
        },
      ]),
    )
    const row = (key: string, item: string, amount: string) => ({
      key,
      cells: [
        { text: item, category: 'other', operandCategories: ['other'], sources: [1] },
        {
          text: amount,
          category: 'contract_amounts',
          operandCategories: ['contract_amounts'],
          sources: [1],
        },
      ],
    })
    const doc = internalDocument()
    doc.sections.push({
      id: 'extra',
      title: 'Dettaglio',
      version: 'both',
      notDeduced: false,
      blocks: [
        {
          kind: 'table',
          id: 'rk',
          title: 'Righe',
          notDeduced: false,
          columns: [
            { id: 'item', title: 'Voce', category: 'other' },
            { id: 'amount', title: 'Importo', category: 'contract_amounts' },
          ],
          rows: [row('a', 'Analisi', '1'), row('b', 'Analisi', '2'), row('c', 'Sviluppo', '3')],
        },
      ],
    } as never)
    const ctx = audienceContext(recipe)
    const { version } = projectClientVersion(doc, ctx)
    const rk = blockOf(version, 'rk')
    if (rk?.kind !== 'table') throw new Error('expected the table')
    expect(rk.rows.map((r) => r.key)).toEqual(['1', '2', rowKeyOf(['Sviluppo'])])
    // The gate agrees on the keys of the version.
    expect(checkAudience(version, ctx, doc).anomalies.filter((a) => a.status === 'open')).toEqual(
      [],
    )
    expect(fillTitle('Sintesi del periodo {{ period }}', ctx.parameters, 'it')).toBe(
      'Sintesi del periodo ottobre 2026',
    )
  })

  it('flags words written with letters of different alphabets', () => {
    const doc = internalDocument()
    const summary = doc.sections[1]?.blocks[1]
    if (summary?.kind === 'text') {
      summary.segments.push({
        text: 'Il cоsto orario medio resta stabile.',
        nature: 'inference',
        category: 'other',
        sources: [],
        sourceCategories: [],
      })
    }
    const { version, report } = projectClientVersion(doc, audienceContext())
    const mixed = report.anomalies.find((a) => a.code === 'mixed_script_in_client')
    expect(mixed).toMatchObject({ acceptable: true, status: 'open', class: 'data' })
    expect(textOf(version)).not.toContain('orario medio')
    if (mixed) expect(audienceFindingText(mixed, 'it')).toContain('alfabeti diversi')
  })

  it('counts every element it checks', () => {
    const { report } = projectClientVersion(internalDocument(), audienceContext())
    // Two notes, the document title, three section titles, two table titles, twelve columns...
    expect(report.checks).toBeGreaterThanOrEqual(20)
  })
})
