import type { Extraction } from '@octobrief/domain'
import { TextBudget } from './budget.ts'
import { pack, type Unit } from './pack.ts'
import { failed, result } from './result.ts'
import { decodeXml, elements, inlineTextOf, officeMetadataDate, removeElements } from './xml.ts'
import { readZip } from './zip.ts'

const MAIN = 'word/document.xml'

/**
 * What a Word run writes besides its text: a line break (a Teams transcript puts one between the
 * speaker with the time and what they said), a tab, a hyphen that does not break.
 */
const DOCX_MARKS: Readonly<Record<string, string>> = {
  'w:br': '\n',
  'w:cr': '\n',
  'w:tab': '\t',
  'w:ptab': '\t',
  'w:noBreakHyphen': '-',
}

/**
 * Word documents, read straight from `word/document.xml` (paragraph boundaries are what the
 * locators need, and a plain XML scan gives them exactly). Paragraphs, empty ones included, are
 * numbered from 1 in document order; consecutive ones are merged up to the chunk size and the
 * locator is the index of the first. Line breaks and tabs inside a paragraph are kept, so the
 * words on either side of them stay apart.
 */
export function extractDocx(bytes: Uint8Array): Extraction {
  const zip = readZip(bytes, (name) => name === MAIN || name === 'docProps/core.xml')
  if (!zip.ok) return failed(zip.reason === 'encrypted' ? 'encrypted' : 'unsupported_format')
  const main = zip.files[MAIN]
  if (!main) return failed('unsupported_format')

  const budget = new TextBudget()
  const units: Unit<number>[] = []
  for (const [i, p] of elements(decodeXml(main), 'w:p').entries()) {
    // The paragraph properties hold its tab stops (`w:tabs`), which are not text.
    const raw = inlineTextOf(removeElements(p.body, 'w:pPr'), 'w:t', DOCX_MARKS)
    if (raw.trim() === '') continue
    const text = budget.take(raw)
    if (text === null) break
    units.push({ at: i + 1, text })
  }
  return result(
    pack(units).map((g) => ({ locator: { kind: 'paragraph', index: g.first }, text: g.text })),
    {
      truncated: budget.truncated,
      metadataDate: officeMetadataDate(zip.files['docProps/core.xml']),
      createdDate: officeMetadataDate(zip.files['docProps/core.xml'], ['dcterms:created']),
    },
  )
}
