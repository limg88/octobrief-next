import type { Extraction } from '@octobrief/domain'
import { extractDocx } from './docx.ts'
import { extractPdf } from './pdf.ts'
import { extractPptx } from './pptx.ts'
import { failed, result } from './result.ts'
import { extractText, isTextFormat } from './text.ts'
import { extractXlsx } from './xlsx.ts'

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'])

type Format = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text' | 'image' | 'unknown'

function detect(mediaType: string, extension: string): Format {
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType === DOCX_TYPE) return 'docx'
  if (mediaType === PPTX_TYPE) return 'pptx'
  if (mediaType === XLSX_TYPE) return 'xlsx'
  if (mediaType.startsWith('image/')) return 'image'
  if (isTextFormat(mediaType, extension)) return 'text'
  // The media type is vague (octet-stream, empty, unknown): the file extension decides.
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return 'docx'
  if (extension === 'pptx') return 'pptx'
  if (extension === 'xlsx') return 'xlsx'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'unknown'
}

/**
 * Text with locators from the bytes of a file. Pure and deterministic: no I/O, no environment.
 * It never throws: whatever cannot be read becomes a warning in the result (`encrypted`,
 * `unsupported_format`, `no_text`, `truncated`).
 */
export async function extract(
  bytes: Uint8Array,
  mediaType: string,
  fileName: string,
): Promise<Extraction> {
  const type = (mediaType.split(';')[0] ?? '').trim().toLowerCase()
  const extension = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : ''
  try {
    switch (detect(type, extension)) {
      case 'pdf':
        return await extractPdf(bytes)
      case 'docx':
        return extractDocx(bytes)
      case 'pptx':
        return extractPptx(bytes)
      case 'xlsx':
        return extractXlsx(bytes)
      case 'text':
        return extractText(bytes, type, extension)
      case 'image':
        return result([], { warnings: ['no_text'] })
      default:
        return failed('unsupported_format')
    }
  } catch {
    return failed('unsupported_format')
  }
}
