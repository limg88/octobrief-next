import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extract } from '../src/extract/extract.ts'
import { docx, encryptedPdf, pdfWithPages, pptx, utf8, xlsx } from './support/files.ts'

const PDF = 'application/pdf'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

describe('pdf', () => {
  it('a two-page pdf gives one chunk per page with its page number', async () => {
    const bytes = await pdfWithPages(['Kickoff on Monday', 'Budget approved'])
    const result = await extract(bytes, PDF, 'minutes.pdf')
    expect(result.extractor).toBe('octobrief-extract/2')
    expect(result.warnings).toEqual([])
    expect(result.chunks.map((c) => c.locator)).toEqual([
      { kind: 'page', page: 1 },
      { kind: 'page', page: 2 },
    ])
    expect(result.chunks[0]?.text).toContain('Kickoff on Monday')
    expect(result.chunks[1]?.text).toContain('Budget approved')
  })

  it('a long page is split into several chunks with the same page locator', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `Line number ${i} of a long page`)
    const result = await extract(await pdfWithPages([lines.join('\n')]), PDF, 'long.pdf')
    expect(result.chunks.length).toBeGreaterThan(1)
    for (const chunk of result.chunks) {
      expect(chunk.locator).toEqual({ kind: 'page', page: 1 })
      expect(chunk.text.length).toBeLessThanOrEqual(1500)
    }
  })

  it('the creation date is the metadata date, the modification date the fallback', async () => {
    const created = new Date('2025-03-04T10:00:00Z')
    const modified = new Date('2025-05-06T10:00:00Z')
    const both = await extract(await pdfWithPages(['x'], { created, modified }), PDF, 'a.pdf')
    expect(both.metadataDate).toEqual(created)
    const onlyModified = await extract(await pdfWithPages(['x'], { modified }), PDF, 'a.pdf')
    expect(onlyModified.metadataDate).toEqual(modified)
  })

  it('a pdf without text says there is no text', async () => {
    const result = await extract(await pdfWithPages(['']), PDF, 'scan.pdf')
    expect(result.chunks).toEqual([])
    expect(result.warnings).toEqual(['no_text'])
  })

  it('an encrypted pdf yields a warning, not an exception', async () => {
    const result = await extract(encryptedPdf(), PDF, 'locked.pdf')
    expect(result.chunks).toEqual([])
    expect(result.warnings).toEqual(['encrypted'])
  })

  it('a damaged pdf yields a warning, not an exception', async () => {
    const result = await extract(utf8('%PDF-1.4 this is not a pdf'), PDF, 'broken.pdf')
    expect(result.chunks).toEqual([])
    expect(result.warnings).toEqual(['unsupported_format'])
  })
})

describe('docx', () => {
  it('three paragraphs give their text with the paragraph index of the first one', async () => {
    const bytes = docx(['First paragraph', 'Second paragraph', 'Third paragraph'])
    const result = await extract(bytes, DOCX, 'plan.docx')
    expect(result.warnings).toEqual([])
    expect(result.chunks).toEqual([
      {
        locator: { kind: 'paragraph', index: 1 },
        text: 'First paragraph\nSecond paragraph\nThird paragraph',
      },
    ])
  })

  it('paragraphs are merged only up to the chunk size and empty ones keep their index', async () => {
    const big = 'a'.repeat(1000)
    const result = await extract(docx([big, '', big, 'tail']), DOCX, 'plan.docx')
    expect(result.chunks.map((c) => c.locator)).toEqual([
      { kind: 'paragraph', index: 1 },
      { kind: 'paragraph', index: 3 },
    ])
    expect(result.chunks[1]?.text).toBe(`${big}\ntail`)
  })

  it('xml entities are decoded and never expanded from a declared doctype', async () => {
    const bytes = zipSync({
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "BOOM">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Tom &amp; Jerry &x; &#65;</w:t></w:r></w:p></w:body></w:document>',
      ),
    })
    const result = await extract(bytes, DOCX, 'e.docx')
    expect(result.chunks[0]?.text).toBe('Tom & Jerry &x; A')
  })

  it('a line break or a tab inside a paragraph keeps the words apart', async () => {
    // As a Teams transcript writes a turn: the speaker, a tab, the time, a line break, the words.
    // The tab stops of the paragraph are not text; a word split across runs stays one word.
    const turn =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>Relatore Uno</w:t></w:r><w:r><w:tab/><w:t>0:03</w:t></w:r>' +
      '<w:r><w:br/><w:t xml:space="preserve">Buongiorno, il col</w:t></w:r>' +
      '<w:r><w:t>laudo è confermato</w:t></w:r><w:r><w:cr/><w:t>a fine mese.</w:t></w:r></w:p>'
    const bytes = zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${turn}<w:p><w:r><w:br/></w:r></w:p></w:body></w:document>`,
      ),
    })
    const result = await extract(bytes, DOCX, 'riunione.docx')
    expect(result.chunks).toEqual([
      {
        locator: { kind: 'paragraph', index: 1 },
        text: 'Relatore Uno\t0:03\nBuongiorno, il collaudo è confermato\na fine mese.',
      },
    ])
  })

  /** A docx of one paragraph whose body is written as given. */
  const docxOf = (paragraph: string) =>
    zipSync({
      'word/document.xml': strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p>' +
          paragraph +
          '</w:p></w:body></w:document>',
      ),
    })

  it('a self-closed text element, a positional tab and a non-breaking hyphen are read', async () => {
    const paragraph =
      '<w:r><w:t/><w:t>Consegna</w:t><w:ptab w:relativeTo="margin" w:alignment="right"/>' +
      '<w:t>fine</w:t><w:noBreakHyphen/><w:t>mese</w:t></w:r>'
    const result = await extract(docxOf(paragraph), DOCX, 'nota.docx')
    expect(result.chunks.map((c) => c.text)).toEqual(['Consegna\tfine-mese'])
  })

  it('the modification date wins over the creation date', async () => {
    const bytes = docx(['x'], { modified: '2025-06-01T08:00:00Z', created: '2024-01-01T00:00:00Z' })
    expect((await extract(bytes, DOCX, 'a.docx')).metadataDate).toEqual(
      new Date('2025-06-01T08:00:00Z'),
    )
    const created = docx(['x'], { created: '2024-01-01T00:00:00Z' })
    expect((await extract(created, DOCX, 'a.docx')).metadataDate).toEqual(
      new Date('2024-01-01T00:00:00Z'),
    )
  })

  it('a docx gives its creation date apart from the modification date', async () => {
    const bytes = docx(['x'], { modified: '2025-06-01T08:00:00Z', created: '2024-01-01T00:00:00Z' })
    expect((await extract(bytes, DOCX, 'a.docx')).createdDate).toEqual(
      new Date('2024-01-01T00:00:00Z'),
    )
    const modifiedOnly = docx(['x'], { modified: '2025-06-01T08:00:00Z' })
    expect((await extract(modifiedOnly, DOCX, 'a.docx')).createdDate).toBeUndefined()
  })

  it('a document recognised only by its file extension is read', async () => {
    const result = await extract(docx(['Hello']), 'application/octet-stream', 'Plan.DOCX')
    expect(result.chunks[0]?.text).toBe('Hello')
  })
})

describe('pptx', () => {
  it('two slides give one chunk each, numbered in presentation order', async () => {
    const bytes = pptx([['Goals', 'Ship in May'], ['Risks']], { reversedFiles: true })
    const result = await extract(bytes, PPTX, 'deck.pptx')
    expect(result.chunks).toEqual([
      { locator: { kind: 'slide', slide: 1 }, text: 'Goals\nShip in May' },
      { locator: { kind: 'slide', slide: 2 }, text: 'Risks' },
    ])
  })

  it('a line break inside a slide paragraph keeps the words apart', async () => {
    const bytes = pptx([
      ['Obiettivi</a:t></a:r><a:br><a:rPr lang="it-IT"/></a:br><a:r><a:t>Consegna a maggio'],
    ])
    const result = await extract(bytes, PPTX, 'deck.pptx')
    expect(result.chunks).toEqual([
      { locator: { kind: 'slide', slide: 1 }, text: 'Obiettivi\nConsegna a maggio' },
    ])
  })

  it('the tab stops of a slide paragraph are not text, a tab in its text is kept', async () => {
    const bytes = pptx([
      [
        'Fase\t1</a:t></a:r></a:p><a:p><a:pPr><a:tabLst><a:tab pos="914400" algn="l"/></a:tabLst></a:pPr><a:r><a:t>Avvio',
      ],
    ])
    const result = await extract(bytes, PPTX, 'deck.pptx')
    expect(result.chunks.map((c) => c.text)).toEqual(['Fase\t1\nAvvio'])
  })

  it('a deck without text says there is no text', async () => {
    const result = await extract(pptx([[], []]), PPTX, 'empty.pptx')
    expect(result.warnings).toEqual(['no_text'])
  })
})

describe('xlsx', () => {
  const sheets = [
    {
      name: 'Budget',
      dimension: 'A1:B2',
      rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Total</t></is></c><c r="B2"><f>B1*2</f><v>84</v></c></row>',
    },
    {
      name: 'Notes',
      rows: '<row r="3"><c r="C3" t="str"><v>hello</v></c></row>',
    },
  ]

  it('two sheets give their cells with the sheet name and the first cell of the group', async () => {
    const result = await extract(xlsx(sheets, ['Item']), XLSX, 'budget.xlsx')
    expect(result.chunks).toEqual([
      { locator: { kind: 'cell', sheet: 'Budget', ref: 'A1' }, text: 'Item | 42\nTotal | 84' },
      { locator: { kind: 'cell', sheet: 'Notes', ref: 'C3' }, text: 'hello' },
    ])
  })

  it('cells beyond the declared dimension are still read', async () => {
    const sparse = [
      {
        name: 'Data',
        dimension: 'A1:A1',
        rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(1499)}</t></is></c></row><row r="500"><c r="Z500"><v>9</v></c></row>`,
      },
    ]
    const result = await extract(xlsx(sparse), XLSX, 'sparse.xlsx')
    const text = result.chunks.map((c) => c.text).join('\n')
    expect(text).toContain('9')
    expect(result.chunks.some((c) => c.locator.kind === 'cell' && c.locator.ref === 'Z500')).toBe(
      true,
    )
  })

  it('a workbook with a wrong dimension and no rows says there is no text', async () => {
    const result = await extract(
      xlsx([{ name: 'S', dimension: 'A1:Z99', rows: '' }]),
      XLSX,
      'e.xlsx',
    )
    expect(result.warnings).toEqual(['no_text'])
  })

  it('more than 50,000 non-empty cells are truncated and say so', async () => {
    const rows = Array.from(
      { length: 520 },
      (_, r) =>
        `<row r="${r + 1}">${Array.from(
          { length: 100 },
          (_, c) =>
            `<c r="${String.fromCharCode(65 + (c % 26))}${String.fromCharCode(65 + Math.floor(c / 26))}${r + 1}"><v>1</v></c>`,
        ).join('')}</row>`,
    ).join('')
    const result = await extract(xlsx([{ name: 'Big', rows }]), XLSX, 'big.xlsx')
    expect(result.truncated).toBe(true)
    expect(result.warnings).toContain('truncated')
  })
})

describe('plain text formats', () => {
  it('a text file groups consecutive non-empty lines and keeps their line range', async () => {
    const result = await extract(utf8('one\ntwo\n\nthree\r\nfour'), 'text/plain', 'a.txt')
    expect(result.chunks).toEqual([
      { locator: { kind: 'line', from: 1, to: 2 }, text: 'one\ntwo' },
      { locator: { kind: 'line', from: 4, to: 5 }, text: 'three\nfour' },
    ])
  })

  it('lines are grouped up to the chunk size', async () => {
    const line = 'x'.repeat(700)
    const result = await extract(utf8([line, line, line].join('\n')), 'text/markdown', 'a.md')
    expect(result.chunks.map((c) => c.locator)).toEqual([
      { kind: 'line', from: 1, to: 2 },
      { kind: 'line', from: 3, to: 3 },
    ])
  })

  it('a single very long line is split into several chunks on the same line', async () => {
    const result = await extract(utf8('y'.repeat(4000)), 'text/plain', 'a.txt')
    expect(result.chunks.length).toBe(3)
    for (const chunk of result.chunks) {
      expect(chunk.locator).toEqual({ kind: 'line', from: 1, to: 1 })
    }
    expect(result.chunks.map((c) => c.text).join('')).toBe('y'.repeat(4000))
  })

  it('a csv is read as lines', async () => {
    const result = await extract(utf8('name,role\nAnna,PM'), 'text/csv', 'team.csv')
    expect(result.chunks).toEqual([
      { locator: { kind: 'line', from: 1, to: 2 }, text: 'name,role\nAnna,PM' },
    ])
  })

  it('a vtt keeps the cue text and drops header, cue numbers and timestamps', async () => {
    const vtt =
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nWelcome all\n\n2\n00:00:04.000 --> 00:00:06.000\nLet us start\nwith risks\n'
    const result = await extract(utf8(vtt), 'text/vtt', 'call.vtt')
    expect(result.chunks).toEqual([
      { locator: { kind: 'line', from: 5, to: 5 }, text: 'Welcome all' },
      { locator: { kind: 'line', from: 9, to: 10 }, text: 'Let us start\nwith risks' },
    ])
  })

  it('a text recognised only by its extension is read', async () => {
    const result = await extract(utf8('hello'), 'application/octet-stream', 'notes.md')
    expect(result.chunks[0]?.text).toBe('hello')
  })

  it('a byte order mark is dropped and invalid utf-8 gives replacement characters', async () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('ciao')])
    expect((await extract(withBom, 'text/plain', 'a.txt')).chunks[0]?.text).toBe('ciao')
    const invalid = new Uint8Array([0x61, 0xff, 0x62])
    const result = await extract(invalid, 'text/plain', 'a.txt')
    expect(result.chunks[0]?.text).toBe('a�b')
  })

  it('a text over the line limit is truncated and says so', async () => {
    const lines = Array.from({ length: 20_050 }, (_, i) => `row ${i}`)
    const result = await extract(utf8(lines.join('\n')), 'text/plain', 'big.txt')
    expect(result.truncated).toBe(true)
    expect(result.warnings).toContain('truncated')
    const last = result.chunks.at(-1)?.locator
    expect(last).toMatchObject({ kind: 'line' })
    expect(last?.kind === 'line' && last.to).toBe(20_000)
  })

  it('an empty text says there is no text', async () => {
    const result = await extract(utf8('  \n\n'), 'text/plain', 'a.txt')
    expect(result.chunks).toEqual([])
    expect(result.warnings).toEqual(['no_text'])
  })
})

describe('other files', () => {
  it('an image has no text and is not an error', async () => {
    const result = await extract(new Uint8Array([0x89, 0x50]), 'image/png', 'photo.png')
    expect(result).toMatchObject({ chunks: [], warnings: ['no_text'], truncated: false })
  })

  it('an unhandled format is reported, not thrown', async () => {
    const result = await extract(new Uint8Array([1, 2, 3]), 'application/x-foo', 'a.foo')
    expect(result).toMatchObject({ chunks: [], warnings: ['unsupported_format'] })
  })

  it('a corrupted zip yields a warning, not an exception', async () => {
    const good = docx(['text'])
    const corrupted = good.slice(0, Math.floor(good.length / 2))
    const result = await extract(corrupted, DOCX, 'broken.docx')
    expect(result).toMatchObject({ chunks: [], warnings: ['unsupported_format'] })
  })

  it('a zip with a missing main part yields a warning', async () => {
    const result = await extract(zipSync({ 'other.txt': strToU8('x') }), DOCX, 'x.docx')
    expect(result.warnings).toEqual(['unsupported_format'])
  })

  it('an office file in the old encrypted container is reported as encrypted', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    const result = await extract(ole, XLSX, 'locked.xlsx')
    expect(result.warnings).toEqual(['encrypted'])
  })

  it('a zip with too many entries is refused without being unpacked', async () => {
    const files: Record<string, Uint8Array> = { 'word/document.xml': strToU8('<w:body/>') }
    for (let i = 0; i < 10_001; i++) files[`f/${i}`] = new Uint8Array(0)
    const result = await extract(zipSync(files, { level: 0 }), DOCX, 'many.docx')
    expect(result).toMatchObject({ chunks: [], warnings: ['unsupported_format'] })
  })

  it('a zip declaring more than the uncompressed limit is refused', async () => {
    const huge = new Uint8Array(101 * 1024 * 1024)
    const bytes = zipSync({ 'word/document.xml': huge }, { level: 1 })
    const result = await extract(bytes, DOCX, 'bomb.docx')
    expect(result).toMatchObject({ chunks: [], warnings: ['unsupported_format'] })
  })

  it('the same bytes always give the same extraction', async () => {
    const bytes = docx(['a', 'b'])
    expect(await extract(bytes, DOCX, 'a.docx')).toEqual(await extract(bytes, DOCX, 'a.docx'))
  })
})

describe('text that the database cannot store', () => {
  it('null characters are removed and chunks left empty by it are dropped', async () => {
    const result = await extract(utf8('ab\u0000cd\n\u0000\u0000\nef'), 'text/plain', 'a.txt')
    expect(result.chunks.map((c) => c.text)).toEqual(['abcd', 'ef'])
  })
})
