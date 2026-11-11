import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { generateDeliveryProject } from '../src/generate.ts'
import { docxFromLines } from '../src/office.ts'

describe('synthetic documents', () => {
  it('builds a Word file with one escaped paragraph per line', () => {
    const files = unzipSync(docxFromLines(['Verbale <A&B>', '', 'Fine']))
    const xml = strFromU8(files['word/document.xml'] as Uint8Array)
    expect(xml).toContain('<w:t xml:space="preserve">Verbale &lt;A&amp;B&gt;</w:t>')
    expect(xml).toContain('<w:p/>')
    expect(xml).toContain('>Fine<')
  })

  it('generates the same project for the same seed', () => {
    const first = generateDeliveryProject({ seed: 7 })
    const second = generateDeliveryProject({ seed: 7 })
    expect(first.documents.map((d) => d.fileName)).toEqual(second.documents.map((d) => d.fileName))
    expect(first.truth.facts.length).toBeGreaterThan(0)
  })
})
