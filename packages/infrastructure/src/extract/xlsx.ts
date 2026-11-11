import type { Extraction, TextChunk } from '@octobrief/domain'
import { TextBudget } from './budget.ts'
import { MAX_NON_EMPTY_CELLS } from './limits.ts'
import { pack } from './pack.ts'
import { relationships, resolveTarget } from './package-parts.ts'
import { failed, result } from './result.ts'
import {
  attr,
  decodeEntities,
  decodeXml,
  elements,
  officeMetadataDate,
  removeElements,
  tags,
  textOf,
} from './xml.ts'
import { readZip } from './zip.ts'

function sharedStrings(part: Uint8Array | undefined): string[] {
  if (!part) return []
  // Phonetic hints (`rPh`) are not part of the cell text.
  const xml = removeElements(decodeXml(part), 'rPh')
  return elements(xml, 'si').map((si) => textOf(si.body, 't'))
}

const CELL_REF = /^[A-Z]+[1-9][0-9]*$/

/** `$B$2` and `b2` are B2; anything that is not a cell reference is `undefined`. */
function normalizeRef(declared: string | undefined): string | undefined {
  const ref = declared?.replaceAll('$', '').toUpperCase()
  return ref !== undefined && CELL_REF.test(ref) ? ref : undefined
}

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

/**
 * Excel. Cells are read from the sheet data itself, never from the declared `<dimension>`, which
 * files in the wild get wrong. Each non-empty row is one unit (its values joined by " | ");
 * consecutive rows are merged up to the chunk size and the locator is the sheet and the first
 * non-empty cell of the group. Formulas give their cached value.
 */
export function extractXlsx(bytes: Uint8Array): Extraction {
  const zip = readZip(
    bytes,
    (name) =>
      name.startsWith('xl/worksheets/') ||
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'docProps/core.xml',
  )
  if (!zip.ok) return failed(zip.reason === 'encrypted' ? 'encrypted' : 'unsupported_format')
  const workbook = zip.files['xl/workbook.xml']
  if (!workbook) return failed('unsupported_format')

  const rels = relationships(zip.files['xl/_rels/workbook.xml.rels'])
  const strings = sharedStrings(zip.files['xl/sharedStrings.xml'])
  const chunks: TextChunk[] = []
  const budget = new TextBudget()
  let cells = 0
  let exhausted = false

  for (const attrs of tags(decodeXml(workbook), 'sheet')) {
    if (exhausted) break
    const name = attr(attrs, 'name') ?? 'Sheet'
    const target = rels.get(attr(attrs, 'r:id') ?? '')
    const part = target ? zip.files[resolveTarget('xl', target)] : undefined
    if (!part) continue

    const rows: { at: string; text: string }[] = []
    let rowNumber = 0
    for (const row of elements(decodeXml(part), 'row')) {
      rowNumber = Number(attr(row.attrs, 'r')) || rowNumber + 1
      const values: string[] = []
      let first: string | undefined
      let column = -1
      for (const cell of elements(row.body, 'c')) {
        const declared = normalizeRef(attr(cell.attrs, 'r'))
        column = declared ? columnIndex(declared) : column + 1
        const raw = cellValue(cell, strings)
        if (raw === '') continue
        // Every value is taken from the budget: shared strings can make a small file expand.
        const value = cells + 1 > MAX_NON_EMPTY_CELLS ? null : budget.take(raw)
        if (value === null) {
          budget.truncated = true
          exhausted = true
          break
        }
        cells++
        first ??= declared ?? `${columnName(column)}${rowNumber}`
        values.push(value)
      }
      if (first !== undefined) rows.push({ at: first, text: values.join(' | ') })
      if (exhausted) break
    }
    for (const group of pack(rows)) {
      chunks.push({ locator: { kind: 'cell', sheet: name, ref: group.first }, text: group.text })
    }
  }
  return result(chunks, {
    truncated: budget.truncated,
    metadataDate: officeMetadataDate(zip.files['docProps/core.xml']),
  })
}

function cellValue(cell: { attrs: string; body: string }, strings: string[]): string {
  const type = attr(cell.attrs, 't')
  const raw = elements(cell.body, 'v')[0]?.body
  switch (type) {
    case 's':
      return (strings[Number(raw)] ?? '').trim()
    case 'inlineStr':
      return textOf(cell.body, 't').trim()
    case 'b':
      return raw === undefined ? '' : raw.trim() === '1' ? 'TRUE' : 'FALSE'
    case 'e':
      return ''
    default:
      return raw === undefined ? '' : decodeEntities(raw).trim()
  }
}
