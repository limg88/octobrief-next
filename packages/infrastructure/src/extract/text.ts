import type { Extraction, TextChunk } from '@octobrief/domain'
import { TextBudget } from './budget.ts'
import { MAX_LINES_OR_FRAGMENTS } from './limits.ts'
import { pack, type Unit } from './pack.ts'
import { result } from './result.ts'

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/vtt'])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'vtt'])

/**
 * Whether the file is plain text: by a known text media type, or by a known text extension
 * whatever the media type says (browsers send `text/x-markdown`, `text/x-csv`, octet-stream...).
 */
export function isTextFormat(mediaType: string, extension: string): boolean {
  return TEXT_TYPES.has(mediaType) || TEXT_EXTENSIONS.has(extension)
}

/**
 * UTF-8 decoded without throwing: the byte order mark is dropped by the decoder, invalid
 * sequences become replacement characters, and null characters (which a database cannot store)
 * are removed.
 */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replaceAll('\u0000', '')
}

const TIMESTAMP = /-->/
const CUE_NUMBER = /^\d+$/

/**
 * Line-based text. Consecutive non-empty lines are grouped up to the chunk size, the locator is
 * the range of lines of the original file. For WebVTT the header, cue numbers and timestamp lines
 * are not text; they stay inside the line range of the cue.
 */
export function extractText(bytes: Uint8Array, mediaType: string, extension: string): Extraction {
  const vtt = mediaType === 'text/vtt' || extension === 'vtt'
  const allLines = decodeText(bytes).split(/\r\n|\n|\r/)
  let truncated = allLines.length > MAX_LINES_OR_FRAGMENTS
  const lines = truncated ? allLines.slice(0, MAX_LINES_OR_FRAGMENTS) : allLines
  const budget = new TextBudget()

  // A run is a sequence of consecutive non-empty lines; runs are packed separately so that a
  // blank line (a paragraph or cue boundary) always ends a chunk.
  const chunks: TextChunk[] = []
  let run: Unit<number>[] = []
  const flush = (): void => {
    for (const group of pack(run)) {
      chunks.push({
        locator: { kind: 'line', from: group.first, to: group.last },
        text: group.text,
      })
    }
    run = []
  }

  for (const [i, raw] of lines.entries()) {
    const lineNo = i + 1
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flush()
      continue
    }
    if (vtt) {
      if (lineNo === 1 && line.startsWith('WEBVTT')) continue
      if (TIMESTAMP.test(line)) continue
      if (CUE_NUMBER.test(line.trim()) && TIMESTAMP.test(lines[i + 1] ?? '')) continue
    }
    const text = budget.take(line)
    if (text === null) break
    run.push({ at: lineNo, text })
  }
  flush()
  truncated ||= budget.truncated
  return result(chunks, { truncated })
}
