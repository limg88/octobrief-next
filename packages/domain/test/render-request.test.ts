import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type DeliverableDocument,
  documentSchema,
  expectedRenderCounts,
  NEUTRAL_TEMPLATE_SLUGS,
  RENDER_FINDINGS,
  type RenderLayout,
  recipeDictionary,
  renderEnvelope,
  SAL_CELL_NAMES,
  SAL_TEMPLATE_SLUG,
  TEMPLATE_FORMATS,
  type TemplateFormat,
} from '../src/recipe/index.ts'

// The fixtures are shared with the tests of the renderer (pytest): both sides check the same
// documents against the same contract and agree on the counts a file must have.
const FIXTURES = new URL('./fixtures/render/', import.meta.url)

interface RenderFixture {
  description: string
  templates: Record<TemplateFormat, string>
  layout: RenderLayout
  expected: Record<TemplateFormat, Record<string, number>>
  document: DeliverableDocument
}

const renderFixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json') && !f.startsWith('invalid-'))
  .map((f) => ({
    file: f,
    fixture: JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8')) as RenderFixture,
  }))

const invalid = JSON.parse(readFileSync(new URL('invalid-documents.json', FIXTURES), 'utf8')) as {
  cases: { description: string; document: unknown }[]
}

describe('the shared render fixtures', () => {
  it('are documents of the model', () => {
    expect(renderFixtures.length).toBeGreaterThanOrEqual(2)
    for (const { file, fixture } of renderFixtures) {
      expect(documentSchema.safeParse(fixture.document).success, file).toBe(true)
    }
  })

  it('refuse every invalid document', () => {
    for (const c of invalid.cases) {
      expect(documentSchema.safeParse(c.document).success, c.description).toBe(false)
    }
  })

  it('expect the counts the core computes, in every format', () => {
    for (const { file, fixture } of renderFixtures) {
      for (const format of TEMPLATE_FORMATS) {
        expect(expectedRenderCounts(fixture.document, format, fixture.layout), file).toEqual(
          fixture.expected[format],
        )
      }
    }
  })

  it('name only templates of the library and cells of the SAL form', () => {
    const slugs = new Set([...Object.values(NEUTRAL_TEMPLATE_SLUGS), SAL_TEMPLATE_SLUG])
    const names = new Set<string>(Object.values(SAL_CELL_NAMES))
    for (const { fixture } of renderFixtures) {
      for (const slug of Object.values(fixture.templates)) expect(slugs.has(slug)).toBe(true)
      for (const cell of fixture.layout.namedCells) expect(names.has(cell.name)).toBe(true)
    }
  })
})

const statusFixture = renderFixtures.find((f) => f.file === 'status-internal.json')
  ?.fixture as RenderFixture
const doc = statusFixture.document
const noLayout: RenderLayout = { sections: [], namedCells: [] }

describe('expectedRenderCounts', () => {
  it('counts a heading per section, plus one for the source notes and one for internal notes', () => {
    expect(expectedRenderCounts(doc, 'docx', noLayout)).toEqual({ sections: 5, tables: 1 })
    const bare = { ...doc, sourceNotes: [], internalNotes: [] }
    expect(expectedRenderCounts(bare, 'docx', noLayout)).toEqual({ sections: 3, tables: 1 })
  })

  it('counts a title slide, a slide per section and the slides of the notes', () => {
    expect(expectedRenderCounts(doc, 'pptx', noLayout)).toEqual({ slides: 6, tables: 1 })
    const bare = { ...doc, sections: [], sourceNotes: [], internalNotes: [] }
    expect(expectedRenderCounts(bare, 'pptx', noLayout)).toEqual({ slides: 1, tables: 0 })
  })

  it('counts a workbook table per table block, or only the named cells of a form', () => {
    expect(expectedRenderCounts(doc, 'xlsx', noLayout)).toEqual({ tables: 1, namedCells: 0 })
    const form: RenderLayout = {
      sections: [],
      namedCells: [{ name: SAL_CELL_NAMES.orderTotal, block: 'closed' }],
    }
    expect(expectedRenderCounts(doc, 'xlsx', form)).toEqual({ tables: 0, namedCells: 1 })
  })
})

describe('renderEnvelope', () => {
  it('carries the document, the template in base64, the layout and the expected counts', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    expect(renderEnvelope(doc, 'docx', bytes, noLayout)).toEqual({
      document: doc,
      format: 'docx',
      template: { data: 'UEsDBA==', layout: noLayout },
      expected: { sections: 5, tables: 1 },
    })
  })
})

describe('the texts of the render findings', () => {
  it('has one for every finding', () => {
    const texts = recipeDictionary('it').render as Record<string, string>
    for (const f of RENDER_FINDINGS) expect(texts[f]?.length ?? 0, f).toBeGreaterThan(10)
  })
})
