/** Extraction limits; beyond them the result is truncated and says so. */
export const MAX_LINES_OR_FRAGMENTS = 20_000
export const MAX_NON_EMPTY_CELLS = 50_000
export const MAX_TEXT_CHARS = 12 * 1024 * 1024
/** Target size of one chunk; a single unit longer than this is split. */
export const CHUNK_CHARS = 1_500
/** Zip safety: total uncompressed size and entry count. */
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 10_000

/**
 * Name and version of the extraction: a new version saves the text of the evidence again on its
 * next compile (version 2 keeps the line breaks and tabs inside a Word or slide paragraph).
 */
export const EXTRACTOR = 'octobrief-extract/2'
/** A single value (cell, paragraph, line) longer than this is cut. */
export const MAX_VALUE_CHARS = 100_000
export const MAX_PDF_PAGES = 2_000
