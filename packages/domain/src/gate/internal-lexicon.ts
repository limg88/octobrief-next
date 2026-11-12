import { canonicalText, hasMixedScript } from '../canonical.ts'
import type { Lang } from '../language/index.ts'
import type { DataCategory } from '../recipe/categories.ts'

// The words of the organization that name internal data (costs, rates, margins, estimated days,
// hours worked) and story points. They find internal data in a text the category of its sources
// does not reveal: a heuristic, declared as such. It finds the words, not the meaning: a text
// that talks about a cost without naming it is not found, and a word used in another sense is
// (a false positive is an anomaly the PM can accept). Numbers without a source are the business
// of the source gate, not of this list.

type Lexicon = ReadonlyArray<readonly [DataCategory, readonly string[]]>

const IT: Lexicon = [
  ['costs', ['costo', 'costi', 'costano', 'spesa interna', 'spese interne', 'cost', 'costs']],
  [
    'rates',
    [
      'tariffa',
      'tariffe',
      'costo orario',
      'costo giornaliero',
      'prezzo interno',
      'prezzi interni',
      'rate card',
      'rates',
      'rate cards',
      'daily rate',
      'daily rates',
      'hourly rate',
      'hourly rates',
    ],
  ],
  [
    'margins',
    [
      'margine',
      'margini',
      'marginalità',
      'marginalita',
      'ricarico',
      'markup',
      'mark-up',
      'margin',
      'margins',
    ],
  ],
  [
    'estimates',
    [
      'giornate stimate',
      'giorni stimati',
      'ore stimate',
      'effort stimato',
      'giorni uomo',
      'giornate uomo',
      'giornata uomo',
      'giorni/uomo',
      'gg/uomo',
      'gg/uu',
      'ore uomo',
      'effort',
      'efforts',
      'fte',
      'ftes',
    ],
  ],
  ['hours', ['ore lavorate', 'ore consuntivate', 'ore a consuntivo', 'timesheet']],
  ['story_points', ['story point', 'story points', 'punti storia']],
]

const LEXICONS: Readonly<Record<Lang, Lexicon>> = { it: IT }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Letters of other alphabets that look like Latin ones, folded to them: «соѕто» in Cyrillic
 * reads «costo». Not a full confusable skeleton (UTS #39): the lookalikes of the lowercase and
 * uppercase Latin letters in Cyrillic, Greek and Armenian. One code unit for one, so places in
 * the folded text are places in the text.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  ѕ: 's',
  т: 't',
  у: 'y',
  ԝ: 'w',
  х: 'x',
  ԁ: 'd',
  А: 'A',
  В: 'B',
  Е: 'E',
  Н: 'H',
  І: 'I',
  Ј: 'J',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  Ѕ: 'S',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  С: 'C',
  с: 'c',
  // Greek
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  μ: 'u',
  χ: 'x',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  // Armenian
  օ: 'o',
  ս: 'u',
  ո: 'n',
  հ: 'h',
  ց: 'g',
  ք: 'f',
  Օ: 'O',
  Տ: 'S',
})

/** A text with the look-alike letters of other alphabets read as the Latin letters they imitate. */
export function foldConfusables(text: string): string {
  let out = ''
  for (const ch of text) out += Object.hasOwn(CONFUSABLES, ch) ? CONFUSABLES[ch] : ch
  return out
}

/** Every dash as `-`, and no space around `/` or `-` («gg / uomo» is «gg/uomo»). */
function normalizeSeparators(text: string): string {
  return text.replace(/[‐-―−﹘﹣－]/gu, '-').replace(/ ?([/-]) ?/gu, (_, sep: string) => sep)
}

/**
 * The form a phrase is compared in: canonical, lowercase, the lookalikes of other alphabets read
 * as Latin letters, every dash a space («Risultato-garantito» is «risultato garantito»).
 */
export function phraseForm(text: string): string {
  return foldConfusables(normalizeSeparators(canonicalText(text)))
    .toLowerCase()
    .replace(/-/gu, ' ')
}

/** A term as a pattern: inside it a space and a dash match each other. */
const termPattern = (term: string) =>
  normalizeSeparators(term).split(/[ -]/u).map(escapeRegExp).join('[ -]')

/** The letters a text of each language is written with. */
const ALPHABETS: Readonly<Record<Lang, RegExp>> = {
  it: /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u,
}
const LETTER = /\p{L}/u
/** U+00B5 MICRO SIGN and U+2126 OHM SIGN used as units: right after a number (\u00ab5 \u00b5s\u00bb, \u00ab10 \u03a9\u00bb). */
const UNIT_SIGNS = /(?<=\d\s?)[\u00b5\u2126]/gu

/**
 * Whether a text has letters that do not belong in a text of the language: a word mixing
 * alphabets («cоsto» with a Cyrillic «о»), or, in Italian, any letter outside the Latin alphabet
 * (a word written all in Cyrillic, a Greek name). Read on the canonical text, so invisible
 * characters cannot split a word. A matter for the PM: such a word can hide one of the lexicon.
 */
export function hasForeignLetters(text: string, lang: Lang): boolean {
  // The micro and ohm signs are units, not Greek letters, though NFKC makes them so.
  const canonical = canonicalText(text.replace(UNIT_SIGNS, 'u'))
  if (hasMixedScript(canonical)) return true
  const alphabet = ALPHABETS[lang]
  for (const ch of canonical) if (LETTER.test(ch) && !alphabet.test(ch)) return true
  return false
}

interface Matcher {
  category: DataCategory
  term: string
  re: RegExp
}

const MATCHERS = new Map<Lang, readonly Matcher[]>()

function matchers(lang: Lang): readonly Matcher[] {
  let out = MATCHERS.get(lang)
  if (out === undefined) {
    out = LEXICONS[lang].flatMap(([category, terms]) =>
      terms.map((term) => ({
        category,
        term,
        // Whole words: letters and digits bound a word. Built from this fixed list only.
        re: new RegExp(`(?<![\\p{L}\\d])${termPattern(term)}(?![\\p{L}\\d])`, 'gu'),
      })),
    )
    MATCHERS.set(lang, out)
  }
  return out
}

/** The terms found in a lowercase text, the longest at each place. */
function termsAt(haystack: string, lang: Lang): Matcher[] {
  const spans: Array<{ m: Matcher; from: number; to: number }> = []
  for (const m of matchers(lang)) {
    for (const found of haystack.matchAll(m.re)) {
      spans.push({ m, from: found.index, to: found.index + found[0].length })
    }
  }
  // One sweep in order of start (the longest first at the same start): a span lies inside a
  // longer one when an earlier span ends after it, or ends with it having started before.
  spans.sort((a, b) => a.from - b.from || b.to - a.to)
  const kept: Matcher[] = []
  let maxTo = -1
  let fromAtMaxTo = -1
  for (const s of spans) {
    const inside = maxTo > s.to || (maxTo === s.to && fromAtMaxTo < s.from)
    if (!inside) kept.push(s.m)
    if (s.to > maxTo) {
      maxTo = s.to
      fromAtMaxTo = s.from
    }
  }
  return kept
}

export interface LexiconHit {
  category: DataCategory
  term: string
}

/**
 * The words of the lexicon in a text, in the order of the lexicon, each once. A term inside a
 * longer one found at the same place counts as the longer one only («costo orario» is a rate,
 * not also a cost).
 */
export function internalTermsIn(text: string, lang: Lang): LexiconHit[] {
  const canonical = normalizeSeparators(canonicalText(text))
  if (canonical === '') return []
  // The text as written, and with the lookalikes of other alphabets read as Latin letters.
  const kept = new Set<Matcher>()
  for (const haystack of new Set([canonical, foldConfusables(canonical)])) {
    for (const m of termsAt(haystack.toLowerCase(), lang)) kept.add(m)
  }
  return matchers(lang)
    .filter((m) => kept.has(m))
    .map(({ category, term }) => ({ category, term }))
}
