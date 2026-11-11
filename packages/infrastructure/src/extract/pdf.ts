import type { Extraction, TextChunk } from '@octobrief/domain'
import { getDocumentProxy, getMeta } from 'unpdf'
import { TextBudget } from './budget.ts'
import { MAX_LINES_OR_FRAGMENTS, MAX_PDF_PAGES } from './limits.ts'
import { pack, type Unit } from './pack.ts'
import { failed, result } from './result.ts'

/** `D:YYYYMMDDHHmmSSOHH'mm'` (every part after the year optional) to a Date, or null. */
export function parsePdfDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      value.trim(),
    )
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', sign, oh = '00', om = '00'] = m
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const offset = (Number(oh) * 60 + Number(om)) * 60_000
  const time = sign === '+' ? utc - offset : sign === '-' ? utc + offset : utc
  const date = new Date(time)
  return Number.isNaN(date.getTime()) || Number(y) < 1900 ? null : date
}

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: unknown }).name === 'PasswordException' ||
      /password/i.test(String((error as { message?: unknown }).message)))
  )
}

/** PDF: one chunk per page (a long page is split into several chunks with the same locator). */
export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
  try {
    // The parser takes ownership of the buffer it is given: it gets a copy. Scripting (`eval`)
    // in the document's fonts and functions stays off.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false } as never)
    let metadataDate: Date | null = null
    try {
      const info = (await getMeta(pdf)).info as Record<string, unknown> | undefined
      metadataDate = parsePdfDate(info?.CreationDate) ?? parsePdfDate(info?.ModDate)
    } catch {
      // Metadata is optional.
    }

    // Page by page, so that the page and text limits stop the work instead of applying to a
    // result already held in memory.
    const budget = new TextBudget()
    const chunks: TextChunk[] = []
    let truncated = pdf.numPages > MAX_PDF_PAGES
    pages: for (let number = 1; number <= Math.min(pdf.numPages, MAX_PDF_PAGES); number++) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      page.cleanup()
      const pageText = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
      const units: Unit<number>[] = []
      for (const line of pageText.split(/\r\n|\n|\r/)) {
        if (line.trim() === '') continue
        const text = budget.take(line.trim())
        if (text === null) {
          truncated = true
          for (const group of pack(units)) {
            chunks.push({ locator: { kind: 'page', page: group.first }, text: group.text })
          }
          break pages
        }
        units.push({ at: number, text })
      }
      for (const group of pack(units)) {
        chunks.push({ locator: { kind: 'page', page: group.first }, text: group.text })
      }
      if (chunks.length >= MAX_LINES_OR_FRAGMENTS) {
        truncated = true
        break
      }
    }
    return result(chunks, { truncated: truncated || budget.truncated, metadataDate })
  } catch (error) {
    return failed(isPasswordError(error) ? 'encrypted' : 'unsupported_format')
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined)
  }
}
