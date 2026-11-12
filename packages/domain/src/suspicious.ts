import { withoutInvisible } from './canonical.ts'
import type { Locator } from './extraction.ts'
import { type Lang, vocabulary } from './language/index.ts'

// Detector of text that reads like an instruction to an assistant. What comes from the evidence
// is data, never an instruction: a hit does not reject the evidence (it stays saved and is
// compiled as data), it only records WHICH pattern matched and WHERE (the chunk index). The text
// that matched is never returned or stored.
//
// RULE: a false positive is fixed by NARROWING the pattern that produced it (in language/it.ts),
// never by adding exclusions or widening what is allowed. Patterns are linear in the text.

export const SUSPICIOUS_PATTERNS = [
  'addressed_to_assistant',
  'ignore_rules',
  'send_externally',
  'false_authorization',
  'persistent_memory',
  'prompt_delimiter',
  'write_system',
] as const

export type SuspiciousPattern = (typeof SUSPICIOUS_PATTERNS)[number]

export interface SuspiciousHit {
  pattern: SuspiciousPattern
  chunkIndex: number
  /** The place of the chunk in the document, when storage knows it: where a citation points. */
  locator?: Locator
}

/** Hits beyond this are dropped: a document full of them is already flagged. */
export const MAX_SUSPICIOUS_HITS = 50

/**
 * NFKC and none of the invisible characters the canonical text removes (format characters, bidi
 * controls, variation selectors, …), before and after NFKC so they cannot split a phrase; line
 * breaks kept (for line-anchored patterns).
 */
function clean(text: string): string {
  return withoutInvisible(withoutInvisible(text).normalize('NFKC'))
}

function patternsIn(
  text: string,
  lang: Lang,
  names: readonly SuspiciousPattern[] = SUSPICIOUS_PATTERNS,
): SuspiciousPattern[] {
  const lined = clean(text)
  // Every run of whitespace, line breaks included, becomes one space: a phrase split across
  // lines or padded with spaces still reads as the phrase.
  const collapsed = lined.replace(/\s+/g, ' ')
  const vocab = vocabulary(lang).SUSPICIOUS
  return names.filter((name) =>
    vocab[name].some((re) => re.test(re.source.startsWith('^') ? lined : collapsed)),
  )
}

/** Suspicious patterns per chunk (once per pattern and chunk), at most 50 hits in all. */
export function detectSuspicious(chunks: readonly { text: string }[], lang: Lang): SuspiciousHit[] {
  const hits: SuspiciousHit[] = []
  for (const [chunkIndex, chunk] of chunks.entries()) {
    for (const pattern of patternsIn(chunk.text, lang)) {
      hits.push({ pattern, chunkIndex })
      if (hits.length >= MAX_SUSPICIOUS_HITS) return hits
    }
  }
  return hits
}

/**
 * Whether a text reads as an instruction CLEARLY aimed at an assistant (addressed to it, to
 * override its instructions, send data out, keep something in memory, change the system). The
 * compile guard uses it to refuse a statement of knowledge, so it is high precision: ordinary
 * action items, risks and decisions must pass. `detectSuspicious` may be broader because it only
 * flags the evidence for the PM.
 */
export function looksLikeInstruction(text: string, lang: Lang): boolean {
  return patternsIn(text, lang, vocabulary(lang).INSTRUCTION_PATTERNS).length > 0
}
