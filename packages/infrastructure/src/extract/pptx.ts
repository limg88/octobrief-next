import type { Extraction, TextChunk } from '@octobrief/domain'
import { TextBudget } from './budget.ts'
import { pack, type Unit } from './pack.ts'
import { relationships, resolveTarget } from './package-parts.ts'
import { failed, result } from './result.ts'
import { attr, decodeXml, elements, inlineTextOf, officeMetadataDate, tags } from './xml.ts'
import { readZip } from './zip.ts'

const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/
/** A line break inside a paragraph of a slide (`a:br`); its tabs are written in its text. */
const PPTX_MARKS: Readonly<Record<string, string>> = { 'a:br': '\n' }

/** Slide parts in the order the deck shows them; falls back to the file numbers. */
function slideOrder(files: Record<string, Uint8Array>): string[] {
  const presentation = files['ppt/presentation.xml']
  const rels = relationships(files['ppt/_rels/presentation.xml.rels'])
  const ordered: string[] = []
  if (presentation) {
    for (const attrs of tags(decodeXml(presentation), 'p:sldId')) {
      const target = rels.get(attr(attrs, 'r:id') ?? '')
      const part = target ? resolveTarget('ppt', target) : undefined
      if (part && files[part]) ordered.push(part)
    }
  }
  if (ordered.length > 0) return ordered
  return Object.keys(files)
    .filter((name) => SLIDE.test(name))
    .sort((a, b) => Number(SLIDE.exec(a)?.[1]) - Number(SLIDE.exec(b)?.[1]))
}

/** PowerPoint: one chunk per slide (a very long slide is split), locator is the slide number. */
export function extractPptx(bytes: Uint8Array): Extraction {
  const zip = readZip(
    bytes,
    (name) =>
      SLIDE.test(name) ||
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels' ||
      name === 'docProps/core.xml',
  )
  if (!zip.ok) return failed(zip.reason === 'encrypted' ? 'encrypted' : 'unsupported_format')
  const slides = slideOrder(zip.files)
  if (slides.length === 0) return failed('unsupported_format')

  const chunks: TextChunk[] = []
  const budget = new TextBudget()
  let exhausted = false
  for (const [i, part] of slides.entries()) {
    if (exhausted) break
    const xml = decodeXml(zip.files[part] ?? new Uint8Array())
    const paragraphs: Unit<number>[] = []
    for (const p of elements(xml, 'a:p')) {
      // A line break inside a paragraph keeps its words apart.
      const raw = inlineTextOf(p.body, 'a:t', PPTX_MARKS)
      if (raw.trim() === '') continue
      const text = budget.take(raw)
      if (text === null) {
        exhausted = true
        break
      }
      paragraphs.push({ at: i + 1, text })
    }
    for (const group of pack(paragraphs)) {
      chunks.push({ locator: { kind: 'slide', slide: group.first }, text: group.text })
    }
  }
  return result(chunks, {
    truncated: budget.truncated,
    metadataDate: officeMetadataDate(zip.files['docProps/core.xml']),
  })
}
