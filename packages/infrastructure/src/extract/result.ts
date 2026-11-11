import type { Extraction, ExtractionWarning, TextChunk } from '@octobrief/domain'
import { EXTRACTOR, MAX_LINES_OR_FRAGMENTS, MAX_TEXT_CHARS } from './limits.ts'

interface Options {
  truncated?: boolean
  metadataDate?: Date | null
  createdDate?: Date | null
  warnings?: ExtractionWarning[]
}

/**
 * Builds the extraction, enforcing the global limits (chunks, total text) on whatever the format
 * produced: a result over a limit is cut and marked truncated.
 */
export function result(chunks: TextChunk[], options: Options = {}): Extraction {
  let truncated = options.truncated ?? false
  let kept = chunks
  if (kept.length > MAX_LINES_OR_FRAGMENTS) {
    kept = kept.slice(0, MAX_LINES_OR_FRAGMENTS)
    truncated = true
  }
  let chars = 0
  const within: TextChunk[] = []
  for (const original of kept) {
    // A null character cannot be stored in the database; a chunk it leaves empty is dropped.
    const text = original.text.replaceAll('\u0000', '')
    if (text.trim() === '') continue
    const chunk = text === original.text ? original : { ...original, text }
    chars += chunk.text.length
    if (chars > MAX_TEXT_CHARS) {
      truncated = true
      break
    }
    within.push(chunk)
  }
  const warnings = new Set<ExtractionWarning>(options.warnings)
  if (truncated) warnings.add('truncated')
  if (within.length === 0 && warnings.size === 0) warnings.add('no_text')
  return {
    extractor: EXTRACTOR,
    chunks: within,
    truncated,
    metadataDate: options.metadataDate ?? null,
    ...(options.createdDate ? { createdDate: options.createdDate } : {}),
    warnings: [...warnings],
  }
}

/** Nothing could be read: the only thing to say is why. */
export function failed(warning: ExtractionWarning): Extraction {
  return result([], { warnings: [warning] })
}
