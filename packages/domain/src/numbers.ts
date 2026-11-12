import { canonicalText } from './canonical.ts'
import { type Lang, vocabulary } from './language/index.ts'

// Number semantics, one rule for the compile guard and for the check of the answers:
// - a text holds a SET of numbers; a claim passes when each of its numbers is in the set of its
//   cited sources (order, repetition, sign and units are not compared);
// - Italian notation: dots split thousands and a comma starts the decimals (1.200,5 = 1200.5,
//   and 1,2 is the same number as 1.2); leading and trailing zeros do not count (03 = 3);
// - space-separated thousands (1 200) are read as separate numbers, so they only match when
//   written the same way;
// - numbers in words count as their value when they are claims (`claimedNumbersIn`): a small
//   cardinal only next to a measure, large and compound ones always;
// - digits of every script are read as ASCII digits, after NFKC.

const DECIMAL_DIGIT = /\p{Nd}/u
const DECIMAL_DIGITS = /\p{Nd}/gu

/** The value of a decimal digit of any script: digits come in runs of ten from zero. */
function digitValue(digit: string): string {
  const code = digit.codePointAt(0) ?? 0
  let zero = code
  while (DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1
  return String((code - zero) % 10)
}

/** NFKC, then every decimal digit (Arabic-Indic, Devanagari, …) as its ASCII digit. */
function asciiDigits(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DECIMAL_DIGITS, (d) => (d >= '0' && d <= '9' ? d : digitValue(d)))
}

/** Leading zeros of the integer part and trailing zeros of the decimals removed. */
function canonical(intPart: string, decimals: string): string {
  const int = intPart.replace(/^0+(?=\d)/, '')
  const dec = decimals.replace(/0+$/, '')
  return dec === '' ? int : `${int}.${dec}`
}

/**
 * The numbers written in a text, each in one canonical form so that the same quantity written
 * in two notations compares equal: «1.200,50» is `1200.5`, «03» is `3`. A notation that is not
 * Italian (e.g. «1.5», «10.30») is kept as written. Numbers written in words are not recognized.
 */
export function numbersIn(text: string, lang: Lang): string[] {
  const vocab = vocabulary(lang)
  const found: string[] = []
  for (const [token] of asciiDigits(text).matchAll(vocab.NUMBER_TOKEN)) {
    if (vocab.GROUPED_NUMBER.test(token)) {
      const [int = '', dec = ''] = token.replaceAll('.', '').split(',')
      found.push(canonical(int, dec))
    } else {
      found.push(token)
    }
  }
  return found
}

/**
 * Whether every number `text` claims is shown by at least one of the excerpts (`claimedNumbersIn`
 * against `shownNumbersIn`, the rule of the answers too): no number enters the knowledge without
 * a cited source that contains it.
 */
export function numbersCited(text: string, excerpts: readonly string[], lang: Lang): boolean {
  const shown = new Set(excerpts.flatMap((e) => shownNumbersIn(e, lang)))
  return claimedNumbersIn(text, lang).every((n) => shown.has(n))
}

/**
 * Whether the excerpt `text[start, end)` begins or ends inside a number of `text`, so that it
 * would quote only part of it («200.000» out of «1.200.000», «20» out of «2026», «5%» out of
 * «15%»). A digit next to the cut, or a separator between the cut and a digit, counts as inside.
 *
 * `start` and `end` are string offsets (code units), but the text is read by characters: a digit
 * outside the basic plane («𝟐𝟎𝟐𝟔») is one character, and a cut between its two halves cuts it.
 */
export function cutsNumber(text: string, start: number, end: number, lang: Lang): boolean {
  const separator = vocabulary(lang).NUMBER_SEPARATOR
  const chars = charsAround(text)
  const digit = (c: string) => DECIMAL_DIGIT.test(c)
  const sep = (c: string) => separator.test(c)
  if (chars.splitsPair(start)) return digit(chars.after(start - 1))
  if (chars.splitsPair(end)) return digit(chars.after(end - 1))

  const first = chars.after(start)
  const beforeStart = chars.before(start)
  const startsInside =
    (digit(first) &&
      (digit(beforeStart) || (sep(beforeStart) && digit(chars.before(chars.prev(start)))))) ||
    (sep(first) && digit(beforeStart) && digit(chars.after(chars.next(start))))

  const last = chars.before(end)
  const afterEnd = chars.after(end)
  const endsInside =
    (digit(last) && (digit(afterEnd) || (sep(afterEnd) && digit(chars.after(chars.next(end)))))) ||
    (sep(last) && digit(chars.before(chars.prev(end))) && digit(afterEnd))
  return startsInside || endsInside
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/**
 * Whether `[start, end)` of `text` begins and ends on word boundaries: no letter, digit or mark
 * on both sides of either cut. Offsets are code units, the text is read by characters (as in
 * `cutsNumber`): a letter outside the basic plane is one character, and a cut between the two
 * halves of a character is never a boundary.
 */
export function onWordBoundaries(text: string, start: number, end: number): boolean {
  const chars = charsAround(text)
  if (chars.splitsPair(start) || chars.splitsPair(end)) return false
  const word = (c: string) => c !== '' && WORD_CHAR.test(c)
  const cutsStart = word(chars.after(start)) && word(chars.before(start))
  const cutsEnd = word(chars.before(end)) && word(chars.after(end))
  return !cutsStart && !cutsEnd
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/** Reading `text` by whole characters around string offsets. */
function charsAround(text: string) {
  const unit = (i: number) => text.charCodeAt(i)
  const after = (i: number) =>
    i >= 0 && i < text.length ? String.fromCodePoint(text.codePointAt(i) as number) : ''
  const before = (i: number) => {
    if (i <= 0 || i > text.length) return ''
    const from =
      i >= 2 && isLowSurrogate(unit(i - 1)) && isHighSurrogate(unit(i - 2)) ? i - 2 : i - 1
    return after(from)
  }
  return {
    after,
    before,
    /** Whether offset `i` falls between the two halves of one character. */
    splitsPair: (i: number) =>
      i > 0 && i < text.length && isLowSurrogate(unit(i)) && isHighSurrogate(unit(i - 1)),
    next: (i: number) => i + Math.max(1, after(i).length),
    prev: (i: number) => i - Math.max(1, before(i).length),
  }
}

/** Kinds of data a text can carry; any of them puts a sentence under the source check. */
export const DATA_KINDS = [
  'number',
  'number_word',
  'amount',
  'percentage',
  'date',
  'identifier',
] as const
export type DataKind = (typeof DATA_KINDS)[number]

/** A number written in words, as found in a text. */
interface WordNumber {
  /** The value in canonical form; `null` for parts («metà») and lone multipliers («milioni»). */
  value: string | null
  /** Where the word is in `numberText(text)`. */
  start: number
  end: number
  /** It counts as a claim: large or compound, or within one word of a measure. */
  claimed: boolean
  percentage: boolean
}

/** Longest word read as a cardinal: longer runs of letters are not split into pieces. */
const MAX_NUMBER_WORD = 60
const MAX_PIECES = 6

/** The pieces a word is made of, if it is made only of pieces (at most six). */
function splitPieces(word: string, pieces: readonly string[], depth = 0): string[] | null {
  if (word === '') return []
  if (depth === MAX_PIECES) return null
  for (const piece of pieces) {
    if (!word.startsWith(piece)) continue
    const rest = splitPieces(word.slice(piece.length), pieces, depth + 1)
    if (rest) return [piece, ...rest]
  }
  return null
}

/** The value of a cardinal from its pieces: «duecentocinquanta» is (2 × 100) + 50. */
function cardinalValue(parts: readonly string[], values: Readonly<Record<string, number>>): number {
  let total = 0
  let current = 0
  for (const part of parts) {
    const v = values[part] as number
    if (v === 100) current = (current || 1) * 100
    else if (v >= 1000) {
      total += (current || 1) * v
      current = 0
    } else current += v
  }
  return total + current
}

/** Words and the € and % signs of a canonical, lowercase text, with where they are. */
function tokensOf(text: string): Array<{ token: string; start: number; end: number }> {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[€%]/gu)].map((m) => ({
    token: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }))
}

/**
 * The text numbers and labels are located in: canonical, digits of every script as ASCII,
 * lowercase. Offsets of `claimedNumberSpans` are offsets in it.
 */
export function numberText(text: string): string {
  return asciiDigits(canonicalText(text)).toLowerCase()
}

/**
 * The numbers written in words in a text. A small cardinal («tre», «sei») is claimed only within
 * one word of a measure; large and compound ones («cento», «duemila», «ventitré») always are;
 * «un», «uno», «una» never; «metà», «mezzo» and «un terzo» only before a measure or «del budget».
 */
function wordNumbersIn(text: string, lang: Lang): WordNumber[] {
  const vocab = vocabulary(lang)
  const pieces = Object.keys(vocab.NUMBER_PIECES).sort((a, b) => b.length - a.length)
  const spans = tokensOf(numberText(text))
  const tokens = spans.map((s) => s.token)
  const at = (i: number) => tokens[i] ?? ''
  const pairAt = (i: number, pairs: ReadonlyArray<readonly [string, string]>) =>
    pairs.some(([a, b]) => at(i) === a && at(i + 1) === b)
  /** The measure starting at token `i`, if any. */
  const measureAt = (i: number): string | null => {
    if (pairAt(i, vocab.MEASURE_PAIRS)) return `${at(i)} ${at(i + 1)}`
    return vocab.MEASURE_WORDS.has(at(i)) ? at(i) : null
  }
  const spanOf = (i: number) => ({ start: spans[i]?.start ?? 0, end: spans[i]?.end ?? 0 })
  const measureBefore = (i: number) =>
    vocab.MEASURE_WORDS.has(at(i - 1)) || vocab.MEASURE_WORDS.has(at(i - 2))

  const found: WordNumber[] = []
  tokens.forEach((token, i) => {
    const isPart =
      vocab.PART_WORDS.has(token) || (vocab.FRACTION_WORDS.has(token) && at(i - 1) === 'un')
    if (isPart) {
      const claimed =
        measureAt(i + 1) !== null || measureAt(i + 2) !== null || pairAt(i + 1, vocab.PART_OBJECTS)
      found.push({ value: null, claimed, percentage: false, ...spanOf(i) })
      return
    }
    if (vocab.NOT_NUMBERS.has(token) || token.length > MAX_NUMBER_WORD) return
    if (token === 'cento' && at(i - 1) === 'per') return // the measure «per cento»
    const parts = splitPieces(token, pieces)
    if (!parts || parts.length === 0) return
    const large = parts.length > 1 || parts.some((p) => vocab.MULTIPLIER_PIECES.has(p))
    const next = measureAt(i + 1)
    const near = next !== null || measureAt(i + 2) !== null || measureBefore(i)
    const unitLike = parts.length === 1 && vocab.UNIT_LIKE_PIECES.has(token)
    found.push({
      value: unitLike ? null : String(cardinalValue(parts, vocab.NUMBER_PIECES)),
      claimed: large || near,
      percentage: next !== null && vocab.PERCENT_MEASURES.has(next),
      ...spanOf(i),
    })
  })
  return found
}

const unique = (values: readonly string[]) => [...new Set(values)]

const valuesOf = (words: readonly WordNumber[]) =>
  words.flatMap((w) => (w.value === null ? [] : [w.value]))

/**
 * The numbers a text carries, in canonical form: every digit, and the values of the numbers in
 * words it claims (a small one only next to a measure, large and compound ones always, the
 * articles never). One rule for both sides, so a lone «sei» (verb) or «due» never adds a number.
 */
function carriedNumbersIn(text: string, lang: Lang): string[] {
  const claimed = wordNumbersIn(text, lang).filter((w) => w.claimed)
  return unique([...numbersIn(canonicalText(text), lang), ...valuesOf(claimed)])
}

/** A number a text claims, with where it is written in `numberText(text)`. */
export interface ClaimedNumber {
  value: string
  start: number
  end: number
}

/**
 * The numbers a text claims, as `claimedNumbersIn` reads them, each with its place: digits and
 * claimed numbers in words, in the order they are written.
 */
export function claimedNumberSpans(text: string, lang: Lang): ClaimedNumber[] {
  const vocab = vocabulary(lang)
  const plain = numberText(text)
  const digits = [...plain.matchAll(vocab.NUMBER_TOKEN)].map((m) => {
    const token = m[0]
    let value = token
    if (vocab.GROUPED_NUMBER.test(token)) {
      const [int = '', dec = ''] = token.replaceAll('.', '').split(',')
      value = canonical(int, dec)
    }
    return { value, start: m.index, end: m.index + token.length }
  })
  const words = wordNumbersIn(text, lang).flatMap((w) =>
    w.claimed && w.value !== null ? [{ value: w.value, start: w.start, end: w.end }] : [],
  )
  return [...digits, ...words].sort((a, b) => a.start - b.start)
}

/** Whether a text holds a number written in words, claimed or not («due», «otto», «metà»). */
export function hasNumberWords(text: string, lang: Lang): boolean {
  return wordNumbersIn(text, lang).length > 0
}

/**
 * The numbers a text of the model claims («tre settimane» is 3): each must be in a cited source.
 */
export function claimedNumbersIn(text: string, lang: Lang): string[] {
  return carriedNumbersIn(text, lang)
}

/**
 * The numbers a source shows, by the same rule as a claim, so «3 settimane» can cite «tre
 * settimane» but «6 mesi» cannot cite «Se sei d'accordo».
 */
export function shownNumbersIn(text: string, lang: Lang): string[] {
  return carriedNumbersIn(text, lang)
}

/**
 * The kinds of data written in a text (in its canonical form), in the order of `DATA_KINDS`:
 * numbers in digits of any script, claimed numbers in words («tre settimane», «ventitré»,
 * «metà del budget»), amounts, percentages, dates (numeric, ISO, with a month name, a full month
 * name on its own, relative dates and weekdays) and identifiers (UUIDs, ticket keys). Roman
 * numerals are not recognized.
 */
export function dataKindsIn(text: string, lang: Lang): DataKind[] {
  const vocab = vocabulary(lang)
  const plain = asciiDigits(canonicalText(text))
  const lower = plain.toLowerCase()
  const words = wordNumbersIn(text, lang).filter((w) => w.claimed)
  const found = new Set<DataKind>()
  if (numbersIn(plain, lang).length > 0) found.add('number')
  if (words.length > 0) found.add('number_word')
  if (vocab.AMOUNT.test(lower)) found.add('amount')
  if (vocab.PERCENTAGE.test(lower) || words.some((w) => w.percentage)) found.add('percentage')
  if (vocab.DATES.some((p) => p.test(lower))) found.add('date')
  if (vocab.IDENTIFIERS.some((p) => p.test(plain))) found.add('identifier')
  return DATA_KINDS.filter((k) => found.has(k))
}
