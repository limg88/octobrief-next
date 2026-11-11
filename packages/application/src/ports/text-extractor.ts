import type { Extraction } from '@octobrief/domain'

/** Reads the text of a file with its locators. Never throws: failures are warnings. */
export interface TextExtractor {
  extract(bytes: Uint8Array, mediaType: string, fileName: string): Promise<Extraction>
}
