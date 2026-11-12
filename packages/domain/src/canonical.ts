/**
 * Format characters (\p{Cf}: zero-width space, soft hyphen, joiners, BOM, tags, …) and the other
 * default-ignorable code points (combining grapheme joiner, Hangul fillers, Khmer inherent vowels,
 * Mongolian variation selectors, variation selectors, the unassigned E0000-E0FFF block). Invisible
 * in the UI, they can split a number, a date or a name so that a check no longer sees it.
 */
// The combining ones (U+034F, U+180B-180F, U+FE00-FE0F) are alternatives of their own: in one
// character class with base characters they would read as a single combined character.
const INVISIBLE =
  /\p{Cf}|[\u115f\u1160\u17b4\u17b5\u3164\uffa0\u{e0000}-\u{e0fff}]|\u034f|[\u180b-\u180f]|[\ufe00-\ufe0f]/gu

/** The text without the invisible characters above, everything else (line breaks too) kept. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}

/**
 * The one canonical form of a text written by the model: NFKC, invisible characters removed,
 * every run of whitespace as one space, trimmed. Checks and display both use this form, so what
 * the PM reads is what was checked.
 */
export function canonicalText(text: string): string {
  // Removed before NFKC (so what they split composes again) and after (NFKC can produce one).
  return text
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const LETTER_RUN = /[\p{L}\p{M}]+/gu
const LATIN = /\p{Script=Latin}/u
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u

/**
 * Whether a word of the text mixes Latin letters with Cyrillic or Greek ones («Mаrio» with a
 * Cyrillic «а»): such a word can pass for a name or a number word without matching it. Not a
 * full confusable check (UTS #39 skeletons): a word in one script only is never flagged.
 */
export function hasMixedScript(text: string): boolean {
  for (const [word] of text.matchAll(LETTER_RUN)) {
    if (LATIN.test(word) && LOOKALIKE.test(word)) return true
  }
  return false
}
