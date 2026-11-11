import { isLocator } from '@octobrief/domain'
import { strToU8, zipSync } from 'fflate'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { extract } from '../src/extract/extract.ts'
import { MAX_LINES_OR_FRAGMENTS, MAX_TEXT_CHARS } from '../src/extract/limits.ts'
import { docx, utf8, xlsx } from './support/files.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF = 'application/pdf'
// Hang guard only: slow or coverage-instrumented runners must not fail on absolute time.
const TIME_LIMIT_MS = 20_000
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const wordDocument = (body: string, closed = true) =>
  zipSync({
    'word/document.xml': strToU8(
      closed
        ? `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`
        : `<w:document xmlns:w="w"><w:body>${body}`,
    ),
  })

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  const value = await run()
  return { value, ms: performance.now() - start }
}

describe('hostile xml', () => {
  it('600 KB of unterminated paragraph tags is read in linear time', async () => {
    const bytes = wordDocument('<w:p '.repeat(100_000), false)
    const { value, ms } = await timed(() => extract(bytes, DOCX, 'a.docx'))
    expect(ms).toBeLessThan(TIME_LIMIT_MS)
    expect(value.chunks).toEqual([])
  })

  it('600 KB of unterminated text tags is read in linear time', async () => {
    const bytes = wordDocument(`<w:p>${'<w:t '.repeat(120_000)}`, false)
    const { ms } = await timed(() => extract(bytes, DOCX, 'a.docx'))
    expect(ms).toBeLessThan(TIME_LIMIT_MS)
  })

  it('a paragraph nested in another does not shift the index of the next one', async () => {
    const a = 'a'.repeat(1000)
    const b = 'b'.repeat(300)
    const c = 'c'.repeat(1000)
    const bytes = wordDocument(
      `<w:p><w:r><w:t>${a}</w:t></w:r><w:p><w:r><w:t>${b}</w:t></w:r></w:p></w:p><w:p><w:r><w:t>${c}</w:t></w:r></w:p>`,
    )
    const result = await extract(bytes, DOCX, 'a.docx')
    expect(result.chunks.map((chunk) => chunk.locator)).toEqual([
      { kind: 'paragraph', index: 1 },
      { kind: 'paragraph', index: 2 },
    ])
    expect(result.chunks[1]?.text).toBe(c)
  })

  it('comments are not text and cdata is read as written', async () => {
    const bytes = wordDocument(
      '<w:p><!-- <w:t>hidden</w:t> --><w:r><w:t><![CDATA[a < b & c]]></w:t></w:r></w:p>',
    )
    const result = await extract(bytes, DOCX, 'a.docx')
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(['a < b & c'])
  })

  it('a lone surrogate written as a character reference becomes a replacement character', async () => {
    const result = await extract(docx(['x&#xD800;y&#56320;z']), DOCX, 'a.docx')
    expect(result.chunks[0]?.text).toBe('x�y�z')
  })
})

describe('memory amplification', () => {
  it('a huge shared string referenced by many cells stops at the text budget', async () => {
    const huge = 'x'.repeat(10_000_000)
    const rows = Array.from(
      { length: 10_000 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c></row>`,
    ).join('')
    const bytes = xlsx([{ name: 'S', rows }], [huge])
    const { value, ms } = await timed(() => extract(bytes, XLSX, 'amplified.xlsx'))
    expect(ms).toBeLessThan(TIME_LIMIT_MS)
    expect(value.truncated).toBe(true)
    expect(value.warnings).toContain('truncated')
    const chars = value.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    expect(chars).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(value.chunks.length).toBeLessThanOrEqual(MAX_LINES_OR_FRAGMENTS)
  })

  it('one enormous paragraph is cut and says so', async () => {
    const bytes = docx(['p'.repeat(5_000_000)])
    const { value, ms } = await timed(() => extract(bytes, DOCX, 'big.docx'))
    expect(ms).toBeLessThan(TIME_LIMIT_MS)
    expect(value.truncated).toBe(true)
    expect(value.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeLessThan(
      MAX_TEXT_CHARS,
    )
  })

  it('a text file over the text budget is cut and says so', async () => {
    const line = `${'z'.repeat(999)}\n`
    const bytes = utf8(line.repeat(Math.ceil((MAX_TEXT_CHARS + 100_000) / line.length)))
    const result = await extract(bytes, 'text/plain', 'huge.txt')
    expect(result.truncated).toBe(true)
    expect(result.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeLessThanOrEqual(
      MAX_TEXT_CHARS,
    )
  })
})

describe('line locators and splitting', () => {
  it('a long line after other lines keeps its own line number', async () => {
    const result = await extract(utf8(`a\nb\n${'x'.repeat(4000)}`), 'text/plain', 'a.txt')
    expect(result.chunks.map((chunk) => chunk.locator)).toEqual([
      { kind: 'line', from: 1, to: 2 },
      { kind: 'line', from: 3, to: 3 },
      { kind: 'line', from: 3, to: 3 },
      { kind: 'line', from: 3, to: 3 },
    ])
    for (const chunk of result.chunks) expect(isLocator(chunk.locator)).toBe(true)
  })

  it('a group ends at its own last line, not at the line before the next group', async () => {
    const line = 'q'.repeat(700)
    const result = await extract(
      utf8(`${line}\n${line}\n${line}\n\n${line}`),
      'text/plain',
      'a.txt',
    )
    expect(result.chunks.map((chunk) => chunk.locator)).toEqual([
      { kind: 'line', from: 1, to: 2 },
      { kind: 'line', from: 3, to: 3 },
      { kind: 'line', from: 5, to: 5 },
    ])
  })

  it('a long text is never split inside a surrogate pair', async () => {
    const text = `a${'😀'.repeat(1000)}`
    const result = await extract(utf8(text), 'text/plain', 'emoji.txt')
    expect(result.chunks.length).toBeGreaterThan(1)
    for (const chunk of result.chunks) expect(LONE_SURROGATE.test(chunk.text)).toBe(false)
    expect(result.chunks.map((chunk) => chunk.text).join('')).toBe(text)
  })

  it('markdown and csv sent with an x- media type are read by their extension', async () => {
    const md = await extract(utf8('# Title'), 'text/x-markdown', 'a.md')
    expect(md.chunks[0]?.text).toBe('# Title')
    const csv = await extract(utf8('a,b'), 'text/x-csv', 'a.csv')
    expect(csv.chunks[0]?.text).toBe('a,b')
  })
})

describe('spreadsheet cell references', () => {
  it('absolute and lowercase references give valid locators', async () => {
    const rows =
      '<row r="2"><c r="$B$2"><v>1</v></c></row><row r="3"><c r="c3"><v>2</v></c></row><row r="4"><c r="???"><v>3</v></c></row>'
    const result = await extract(xlsx([{ name: 'S', rows }]), XLSX, 'refs.xlsx')
    expect(result.chunks.length).toBeGreaterThan(0)
    for (const chunk of result.chunks) expect(isLocator(chunk.locator)).toBe(true)
    expect(result.chunks[0]?.locator).toEqual({ kind: 'cell', sheet: 'S', ref: 'B2' })
  })
})

describe('large pdf', () => {
  it('a pdf with more pages than the cap is cut and says so', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false })
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 2_050; i++) {
      doc.addPage([200, 100]).drawText(`p${i}`, { x: 10, y: 50, size: 10, font })
    }
    const result = await extract(await doc.save(), PDF, 'many.pdf')
    expect(result.truncated).toBe(true)
    expect(result.warnings).toContain('truncated')
    const last = result.chunks.at(-1)?.locator
    expect(last?.kind === 'page' && last.page).toBe(2_000)
  }, 30_000)
})
