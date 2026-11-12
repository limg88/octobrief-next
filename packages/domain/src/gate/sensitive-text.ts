import { withoutInvisible } from '../canonical.ts'
import type { Lang } from '../language/index.ts'
import { vocabulary } from '../language/index.ts'
import { foldConfusables } from './internal-lexicon.ts'

// What a deliverable must never show: credentials and secrets (gate 6), and, as a matter of
// form, paths and technical identifiers in the text the model writes (gate 7). Every pattern is
// fixed here, linear in the text, and read on the text without invisible characters, in NFKC and
// with look-alike letters folded, so neither a zero-width space nor a Cyrillic «а» can hide a key.
// A finding says which kind matched, never the text.

export type SensitiveKind = 'credential' | 'secret'

/**
 * A value after a word that names a password, a token or a key, and a separator; whether it is
 * one is decided by `looksLikeSecret`.
 */
const SECRET_FIELD =
  /(?<![\p{L}\p{N}_])(password|passwd|pwd|passcode|passphrase|pass|parola d'ordine|segreto|chiave|pat|token)\s*[:=]\s*["']?([^\s"';,]{6,})/giu
const PASSWORD_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'passcode',
  'passphrase',
  'pass',
  "parola d'ordine",
])
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,200}:[^\s@/]{1,200}@/iu
const AUTH_SCHEME = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/iu
const AUTH_HEADER = /\b(?:proxy-)?authorization\s*:\s*(?:[a-z]+\s+)?\S{8,}/iu
/** Apostrophes and primes as typed by a word processor: «parola d’ordine» is «parola d'ordine». */
const APOSTROPHES = /[’‘ʼ′]/gu

/** Values that are data of a project, never a secret: a date or the key of a work item. */
const NOT_A_SECRET: readonly RegExp[] = [
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/u,
  /^\d{4}-\d{2}-\d{2}$/u,
  /^\d{8}$/u,
  /^[A-Z][A-Z0-9]*-\d+$/u,
]
/** Shortest value after a keyword that can be a secret, in characters as the PM sees them. */
const MIN_KEYWORD_SECRET = 8
/** Shortest value after a password word that can be a password, with a digit or a symbol. */
const MIN_PASSWORD = 6
/** Any value this long after a password word is one. */
const LONG_PASSWORD = 12
const LETTER = /\p{L}/u
const DIGIT_OR_SYMBOL = /\p{N}|[^\p{L}\p{N}]/u
/** After a word other than a password, a dash between letters («capo-progetto») is no symbol. */
const DIGIT_OR_SYMBOL_NOT_DASH = /\p{N}|[^\p{L}\p{N}-]/u
const DIGITS_ONLY = /^\p{N}{16,}$/u
const GRAPHEMES = new Intl.Segmenter('it', { granularity: 'grapheme' })
const TRAILING_PUNCTUATION = /[.,]+$/u

function graphemeCount(text: string): number {
  let n = 0
  for (const _ of GRAPHEMES.segment(text)) n++
  return n
}

/**
 * Whether the value after a keyword is a secret. A date or the key of a work item never is. After
 * a password word: at least 8 characters with a digit or a symbol, or any value of 12. After
 * «token», «pat», «segreto» or «chiave»: at least 8 characters mixing letters with digits or
 * symbols, or a run of 16 digits or more; «chiave: priorità» and «token: scaduto» are words.
 */
function looksLikeSecret(word: string, raw: string): boolean {
  const value = raw.replace(TRAILING_PUNCTUATION, '')
  const length = graphemeCount(value)
  // A word that only names a password («password», «pwd», «parola d'ordine») is never followed
  // by an ordinary date or key: whatever looks like a password after it is one, from 6 characters.
  // «pass» is also an Italian word («pass: 30/11/2026», a pass that expires), so dates and keys
  // after it are not secrets.
  if (PASSWORD_WORDS.has(word) && word !== 'pass') {
    return (length >= MIN_PASSWORD && DIGIT_OR_SYMBOL.test(raw)) || length >= LONG_PASSWORD
  }
  if (NOT_A_SECRET.some((re) => re.test(value))) return false
  if (word === 'pass') {
    return (length >= MIN_PASSWORD && DIGIT_OR_SYMBOL.test(raw)) || length >= LONG_PASSWORD
  }
  if (DIGITS_ONLY.test(value)) return true
  return length >= MIN_KEYWORD_SECRET && LETTER.test(value) && DIGIT_OR_SYMBOL_NOT_DASH.test(value)
}

const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{35}/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /\bAccountKey=[A-Za-z0-9+/=]{20,}/u,
  /[?&]sig=[A-Za-z0-9%+/=]{20,}/u,
  /\bATATT[A-Za-z0-9_\-=]{20,}/u,
  /\bglpat-[A-Za-z0-9_-]{20,}/u,
  /\bSharedAccessKey=[A-Za-z0-9+/=]{20,}/u,
  // A personal access token of Azure DevOps: 52 characters of lowercase base32.
  /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/u,
  /(?<![\p{L}\p{N}_])(?:api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/iu,
]

/**
 * The text the patterns read: without invisible characters, in NFKC, with typographic apostrophes
 * uniform and the look-alike letters of other alphabets read as Latin («pаssword» with a Cyrillic
 * «а» is «password»).
 */
function clean(text: string): string {
  return foldConfusables(
    withoutInvisible(withoutInvisible(text).normalize('NFKC')).replace(APOSTROPHES, "'"),
  )
}

/** The kinds of credential or secret a text holds, credential first. */
export function sensitiveKindsIn(text: string): SensitiveKind[] {
  const t = clean(text)
  const out: SensitiveKind[] = []
  let credential = URL_USERINFO.test(t) || AUTH_SCHEME.test(t) || AUTH_HEADER.test(t)
  if (!credential) {
    for (const [, word = '', value = ''] of t.matchAll(SECRET_FIELD)) {
      if (looksLikeSecret(word.toLowerCase(), value)) {
        credential = true
        break
      }
    }
  }
  if (credential) out.push('credential')
  if (SECRETS.some((re) => re.test(t))) out.push('secret')
  return out
}

export type TechnicalKind = 'path' | 'identifier'

const PATHS: readonly RegExp[] = [
  // An absolute or home path of two parts at least, at the start of a word.
  /(?:^|[\s("'«[])~?\/[\w.-]{1,100}(?:\/[\w.-]{1,100})+/u,
  /(?<![\p{L}\p{N}])[A-Za-z]:\\[^\s\\]{1,100}/u,
  /\\\\[\w.-]{1,100}\\[\w$.-]{1,100}/u,
  /\bfile:\/\/\S/iu,
]

const HASHES: readonly RegExp[] = [
  /\bsha(?:1|256|384|512):[0-9a-f]{16,}/iu,
  /(?<![\p{L}\p{N}])[0-9a-f]{32,}(?![\p{L}\p{N}])/iu,
]

/** Identifiers that are data when cited: the keys of work items, UUIDs. */
function identifierMatchers(lang: Lang): readonly RegExp[] {
  return vocabulary(lang).IDENTIFIERS.map((re) => new RegExp(re.source, `${re.flags}g`))
}

/**
 * The paths and technical identifiers in a text. A key of a work item or a UUID is data, not a
 * technical identifier, when it is one of `citedIds` (the ids of the work items the text cites);
 * a hash never is.
 */
export function technicalKindsIn(
  text: string,
  citedIds: ReadonlySet<string>,
  lang: Lang,
): TechnicalKind[] {
  const t = clean(text)
  const out: TechnicalKind[] = []
  if (PATHS.some((re) => re.test(t))) out.push('path')
  let identifier = HASHES.some((re) => re.test(t))
  if (!identifier) {
    for (const re of identifierMatchers(lang)) {
      for (const [m] of t.matchAll(re)) {
        if (!citedIds.has(m.toLowerCase())) {
          identifier = true
          break
        }
      }
      if (identifier) break
    }
  }
  if (identifier) out.push('identifier')
  return out
}
