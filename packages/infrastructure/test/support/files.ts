import { strToU8, zipSync } from 'fflate'
import { PDFDocument, StandardFonts } from 'pdf-lib'

/** Synthetic files for the tests: nothing here is a real document. */

export async function pdfWithPages(
  pages: string[],
  dates?: { created?: Date; modified?: Date },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  if (dates?.created) doc.setCreationDate(dates.created)
  if (dates?.modified) doc.setModificationDate(dates.modified)
  for (const text of pages) {
    const page = doc.addPage([600, 1200])
    // pdf-lib draws one line per call: split on newlines.
    text.split('\n').forEach((line, i) => {
      page.drawText(line, { x: 20, y: 1160 - i * 16, size: 11, font })
    })
  }
  return doc.save()
}

/** A PDF whose trailer points to a standard security handler: the parser asks for a password. */
export function encryptedPdf(): Uint8Array {
  const hex32 = '00'.repeat(32)
  const body = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
    `4 0 obj << /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >> endobj`,
    `trailer << /Root 1 0 R /Size 5 /Encrypt 4 0 R /ID [<${'11'.repeat(16)}> <${'11'.repeat(16)}>] >>`,
    '%%EOF',
  ].join('\n')
  return strToU8(body)
}

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`

function coreXml(modified?: string, created?: string): string {
  return xml(
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/">${
      created ? `<dcterms:created>${created}</dcterms:created>` : ''
    }${modified ? `<dcterms:modified>${modified}</dcterms:modified>` : ''}</cp:coreProperties>`,
  )
}

export function docx(paragraphs: string[], meta?: { modified?: string; created?: string }) {
  const body = paragraphs
    .map((p) =>
      p === '' ? '<w:p/>' : `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`,
    )
    .join('')
  return zipSync({
    'word/document.xml': strToU8(
      xml(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    ),
    ...(meta ? { 'docProps/core.xml': strToU8(coreXml(meta.modified, meta.created)) } : {}),
  })
}

/** Slides in presentation order; `fileOrder` lets a test put them in different files. */
export function pptx(slides: string[][], opts?: { reversedFiles?: boolean; modified?: string }) {
  const files: Record<string, Uint8Array> = {}
  const n = slides.length
  const fileNumber = (i: number) => (opts?.reversedFiles ? n - i : i + 1)
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${fileNumber(i)}.xml`] = strToU8(
      xml(
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paras
          .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
          .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ),
    )
  })
  files['ppt/presentation.xml'] = strToU8(
    xml(
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
        .join('')}</p:sldIdLst></p:presentation>`,
    ),
  )
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="x" Target="slides/slide${fileNumber(i)}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ),
  )
  if (opts?.modified) files['docProps/core.xml'] = strToU8(coreXml(opts.modified))
  return zipSync(files)
}

export interface SheetSpec {
  name: string
  /** Raw `<sheetData>` XML and the declared dimension. */
  rows: string
  dimension?: string
}

export function xlsx(sheets: SheetSpec[], sharedStrings: string[] = []) {
  const files: Record<string, Uint8Array> = {}
  files['xl/workbook.xml'] = strToU8(
    xml(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ),
  )
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      xml(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
          s.dimension ? `<dimension ref="${s.dimension}"/>` : ''
        }<sheetData>${s.rows}</sheetData></worksheet>`,
      ),
    )
  })
  if (sharedStrings.length > 0) {
    files['xl/sharedStrings.xml'] = strToU8(
      xml(
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings
          .map((s) => `<si><t>${s}</t></si>`)
          .join('')}</sst>`,
      ),
    )
  }
  return zipSync(files)
}

export const utf8 = (text: string) => strToU8(text)
