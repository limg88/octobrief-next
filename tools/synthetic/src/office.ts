import { strToU8, zipSync } from 'fflate'

const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** A minimal Word document, one paragraph per line: enough for any reader of .docx text. */
export function docxFromLines(lines: readonly string[]): Uint8Array {
  const body = lines
    .map((line) =>
      line === ''
        ? '<w:p/>'
        : `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    )
    .join('')
  return zipSync({
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
    ),
  })
}
