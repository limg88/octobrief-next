import type { TextExtractor } from '@octobrief/application'
import { extractIsolated } from './isolated.ts'

/** Extraction in a child process with memory and time limits: a hostile file costs the child. */
export function createIsolatedExtractor(): TextExtractor {
  return { extract: (bytes, mediaType, fileName) => extractIsolated(bytes, mediaType, fileName) }
}
