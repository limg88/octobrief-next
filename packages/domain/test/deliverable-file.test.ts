import { describe, expect, it } from 'vitest'
import {
  type Acceptance,
  binaryFormatOf,
  canonicalHash,
  clientDeclaredValues,
  clientSuspendedNotes,
  DELIVERABLE_CONTENT_TYPES,
  deliverableFileName,
  documentSchema,
  fileAudiences,
  fileDocument,
  fileInstant,
  fileLayout,
  type InternalDocument,
  isRenderFailure,
  projectClientVersion,
  RENDER_FAILURE_CODES,
  RENDER_FINDINGS,
  type RenderCheckOutcome,
  renderFailureOf,
  renderFailureText,
  renderMarkdown,
  TEMPLATE_REFUSALS,
} from '../src/recipe/index.ts'
import {
  AS_OF,
  audienceContext,
  DWSI_TITLE,
  INTERNAL_NOTE,
  internalDocument,
  recipeOf,
} from './support/client-version.ts'

// The files of an approved deliverable as the core makes them: the Markdown, the same for the
// same document; the client file with generic notes and no internal note; the figures of a
// stale source suspended; the notes each once; the layout limited to what the document holds.

const client = (acceptances: readonly Acceptance[] = []) =>
  projectClientVersion(internalDocument(), audienceContext(), acceptances)

describe('the Markdown of a deliverable', () => {
  it('is the same for the same document', () => {
    const doc = internalDocument()
    expect(renderMarkdown(doc)).toBe(renderMarkdown(structuredClone(doc)))
  })

  it('opens with the title and the age of the data, never the live age', () => {
    const md = renderMarkdown(internalDocument())
    expect(md.startsWith('# SAL economico\n')).toBe(true)
    expect(md).toContain(
      `_Dati al ${fileInstant(AS_OF)}, generato il ${fileInstant('2026-11-06T09:30:00.000Z')}_`,
    )
    expect(fileInstant(AS_OF)).toBe('05/11/2026 08:00')
  })

  it('shows the full titles of the sources and the notes for the PM in the internal file', () => {
    const md = renderMarkdown(internalDocument())
    expect(md).toContain(`3. ${DWSI_TITLE}, dati al 05/11/2026 08:00`)
    expect(md).toContain('## Note per il PM')
    expect(md).toContain(INTERNAL_NOTE)
    expect(md).toContain('## Consuntivo del team')
  })

  it('the client file contains no internal note and no internal title', () => {
    const doc = client().version.document
    const md = renderMarkdown(fileDocument(doc, [], 'it'))
    expect(md).not.toContain(INTERNAL_NOTE)
    expect(md).not.toContain('Note per il PM')
    expect(md).not.toContain(DWSI_TITLE)
    expect(md).not.toContain('Ordine 4711')
    expect(md).not.toContain('Fatturazione elettronica')
    expect(md).not.toContain('Consuntivo del team')
    // No place of a source: no evidence id, no view, no key.
    for (const technical of ['ev-dwsi', 'v_sales_order_all', 'salesorderid', 'dwsi']) {
      expect(md).not.toContain(technical)
    }
    expect(md).toContain('## Fonti')
    // The generic note says the day of its data once.
    expect(md).toContain('1. Sistema amministrativo, dati al 05/11/2026\n')
    expect(md).not.toContain('dati al 05/11/2026, dati al')
  })

  it('keeps figures as they are written', () => {
    const md = renderMarkdown(internalDocument())
    expect(md).toContain("**Totale dell'ordine:** 12.000,00 € [1]")
  })

  it('writes the text of the sources as text, never as links or headings', () => {
    const doc = internalDocument()
    const block = doc.sections[1]?.blocks[1]
    if (block?.kind !== 'text') throw new Error('fixture changed')
    ;(block.segments[0] as { text: string }).text = '[clic](http://example.test) <b>x</b> # titolo'
    const intro = doc.sections[1]?.blocks[0]
    if (intro?.kind !== 'static') throw new Error('fixture changed')
    intro.text = '- non è un elenco\n1. né questo'
    const md = renderMarkdown(doc)
    expect(md).toContain('\\[clic\\]\\(http://example.test\\) \\<b\\>x\\</b\\> \\# titolo')
    expect(md).not.toContain('[clic](')
    expect(md).toContain('\\- non è un elenco\n1\\. né questo')
  })

  it('marks «non dedotto» where no value could be deduced', () => {
    const doc = internalDocument()
    const value = doc.sections[0]?.blocks[1]
    if (value?.kind !== 'value') throw new Error('fixture changed')
    value.cell.text = null
    expect(renderMarkdown(doc)).toContain("**Totale dell'ordine:** _non dedotto_")
  })
})

describe('the source notes of a file', () => {
  it('are each once, and a datum cites each note once', () => {
    const doc = internalDocument()
    // Two places of the same evidence read the same in the file: one note.
    doc.sourceNotes.push({
      n: 5,
      label: DWSI_TITLE,
      dataAsOf: AS_OF,
      ref: { kind: 'evidence', evidenceId: 'ev-dwsi', locator: { kind: 'page', page: 2 } },
    })
    const total = doc.sections[0]?.blocks[1]
    if (total?.kind !== 'value') throw new Error('fixture changed')
    total.cell.sources = [3, 5]
    const file = fileDocument(doc, [], 'it')
    expect(file.sourceNotes.map((n) => n.n)).toEqual([1, 2, 3, 4])
    const shown = file.sections[0]?.blocks[1]
    if (shown?.kind !== 'value') throw new Error('fixture changed')
    expect(shown.cell.sources).toEqual([3])
    expect(documentSchema.safeParse(file).success).toBe(true)
    const md = renderMarkdown(file)
    expect(md.match(new RegExp(DWSI_TITLE, 'g'))).toHaveLength(1)
    // A segment that cites one note for two operands shows it once.
    expect(md).toContain("Fatturati 8.000,00 € sui 12.000,00 € dell'ordine. [1]")
  })
})

describe('the source notes of the internal file', () => {
  it('keep apart two sources with the same title and date', () => {
    const doc = internalDocument()
    // Another piece of evidence that happens to have the same title and date.
    doc.sourceNotes.push({
      n: 5,
      label: DWSI_TITLE,
      dataAsOf: AS_OF,
      ref: { kind: 'evidence', evidenceId: 'ev-other', locator: { kind: 'page', page: 1 } },
    })
    const total = doc.sections[0]?.blocks[1]
    if (total?.kind !== 'value') throw new Error('fixture changed')
    total.cell.sources = [3, 5]
    const file = fileDocument(doc, [], 'it')
    expect(file.sourceNotes.map((n) => n.n)).toEqual([1, 2, 3, 4, 5])
    const shown = file.sections[0]?.blocks[1]
    if (shown?.kind !== 'value') throw new Error('fixture changed')
    expect(shown.cell.sources).toEqual([3, 5])
  })

  it('merge the client notes that read the same, whatever they stand for', () => {
    const projected = client().version.document
    const first = projected.sourceNotes[0]
    if (!first) throw new Error('fixture changed')
    const twice = { ...projected, sourceNotes: [...projected.sourceNotes, { ...first, n: 99 }] }
    const file = fileDocument(twice, [], 'it')
    expect(file.sourceNotes).toHaveLength(projected.sourceNotes.length)
  })
})

describe('a stale source in the file', () => {
  it('suspends the figures that cite it, as in the draft shown to the PM', () => {
    const file = fileDocument(internalDocument(), [1], 'it')
    const md = renderMarkdown(file)
    expect(md).not.toContain('12.000,00 €')
    expect(md).toContain('Dato sospeso: la fonte non è aggiornata.')
    expect(md).toContain('Chiusa')
  })

  it('suspends in the client file the notes that stand for the same place', () => {
    const projected = client()
    const notes = clientSuspendedNotes(internalDocument(), [1], projected.version.notes)
    expect(notes).toHaveLength(1)
    const file = fileDocument(projected.version.document, notes, 'it')
    expect(renderMarkdown(file)).not.toContain('12.000,00 €')
    expect(clientSuspendedNotes(internalDocument(), [], projected.version.notes)).toEqual([])
  })
})

describe('the layout of a file', () => {
  it('keeps only the sections and named cells the document holds', () => {
    const doc = client().version.document
    const layout = fileLayout(
      {
        sections: [
          { section: 'order', sheet: 'Posizioni' },
          { section: 'team', sheet: 'Ore' },
        ],
        namedCells: [
          { name: 'TotaleOrdine', block: 'order_total' },
          { name: 'OreTeam', block: 'hours', column: 'duration' },
          { name: 'Importo', block: 'positions', column: 'amount' },
          { name: 'Mancante', block: 'positions', column: 'missing' },
        ],
      },
      doc,
    )
    expect(layout.sections.map((s) => s.section)).toEqual(['order'])
    expect(layout.namedCells.map((c) => c.name)).toEqual(['TotaleOrdine', 'Importo'])
  })
})

describe('the values declared to the client', () => {
  it('are the values and cells the client file shows, never the internal ones', () => {
    const recipe = recipeOf()
    const values = clientDeclaredValues(client().version.document, recipe, {
      period: { from: '2026-10-01', to: '2026-10-31' },
    })
    expect(values).toContainEqual({
      sectionId: 'order',
      cellId: '["order_total"]',
      value: '12.000,00 €',
      period: '2026-10-01..2026-10-31',
    })
    expect(values.some((v) => v.sectionId === 'team')).toBe(false)
    expect(values.some((v) => v.value === '120')).toBe(false)
  })

  it('leave out a cell that shows no value', () => {
    const doc = fileDocument(client().version.document, [1], 'it')
    const values = clientDeclaredValues(doc, recipeOf(), {})
    expect(values.some((v) => v.cellId === '["order_total"]')).toBe(false)
    expect(values.every((v) => v.period === null)).toBe(true)
  })
})

describe('the files of a recipe', () => {
  it('are the internal and the client one for both audiences', () => {
    expect(fileAudiences('both')).toEqual(['internal', 'client'])
    expect(fileAudiences('client')).toEqual(['client'])
    expect(fileAudiences('internal')).toEqual(['internal'])
    expect(binaryFormatOf({ formats: ['md', 'xlsx'] })).toBe('xlsx')
    expect(binaryFormatOf({ formats: ['md'] })).toBeNull()
  })

  it('are named with safe characters only, and have a fixed content type', () => {
    const doc = internalDocument()
    expect(deliverableFileName(doc, 'client', 'xlsx')).toBe('sal-economico-1.0.0-cliente.xlsx')
    expect(deliverableFileName(doc, 'internal', 'md')).toBe('sal-economico-1.0.0-interno.md')
    const odd = { recipe: { ...doc.recipe, slug: 'a"b\r\n/../c', version: '1.0.0' } }
    expect(deliverableFileName(odd, 'client', 'md')).toMatch(/^[a-z0-9.-]+$/)
    expect(DELIVERABLE_CONTENT_TYPES.md).toBe('text/markdown; charset=utf-8')
  })

  it('give the client file of an accepted internal value only for the accepted content', () => {
    // The margin sentence is internal: withheld, unless accepted for that very content.
    const withheld = renderMarkdown(client().version.document)
    expect(withheld).not.toContain('18% sul venduto')
    const anomaly = client().report.anomalies.find(
      (a) => a.code === 'internal_data_in_client' && a.ref.element === 'segment',
    )
    if (!anomaly) throw new Error('fixture changed')
    const acceptance: Acceptance = {
      code: anomaly.code,
      refKey: anomaly.refKey,
      contentHash: anomaly.contentHash,
      reason: 'Il cliente conosce già il margine del progetto.',
      by: 'pm',
      at: AS_OF,
    }
    expect(renderMarkdown(client([acceptance]).version.document)).toContain('18% sul venduto')
    // The same acceptance on another content does not let it in.
    const other = { ...acceptance, contentHash: canonicalHash('another content') }
    expect(renderMarkdown(client([other]).version.document)).not.toContain('18% sul venduto')
  })
})

describe('why a render gave no file', () => {
  it('has the words of a PM for every reason, never a code', () => {
    for (const code of [...RENDER_FAILURE_CODES, ...RENDER_FINDINGS, ...TEMPLATE_REFUSALS]) {
      expect(isRenderFailure(code)).toBe(true)
      const text = renderFailureText(code, 'it')
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toContain('_')
    }
    expect(isRenderFailure('anything_else')).toBe(false)
  })

  it('is the first finding of a failed check of the renderer', () => {
    const checks: RenderCheckOutcome[] = [
      { subject: 'request', check: 'request', passed: true, findings: [] },
      { subject: 'file', check: 'counts', passed: false, findings: ['count_mismatch'] },
    ]
    expect(renderFailureOf(checks)).toBe('count_mismatch')
    expect(renderFailureOf([])).toBe('file_check_failed')
  })
})

// The document type keeps the internal version apart from the client one.
const _typed: InternalDocument = internalDocument()
void _typed
