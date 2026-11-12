import { COMPANY_FORM, displayCore, nameSegments, personNameCore } from './display-name.ts'
import { DomainError } from './errors.ts'
import { LANGS, vocabulary } from './language/index.ts'
import { firstNameVariants, GREETINGS, WORD_NAMES } from './name-variants.ts'
import { ORGANIZATION_WITH_FORM } from './organizations.ts'
import { isGroupOrCommonWord, isGroupWord, notAPersonReason } from './people-filter.ts'

export interface PseudonymMap {
  /** Exact original text (NFC) to token. */
  toPseudonym: Map<string, string>
  /** Token to exact original text (NFC). */
  toReal: Map<string, string>
}

/**
 * How far the name of a person is trusted to be one:
 * - absent: a member, a person of the project's history or of its knowledge: every alias;
 * - `seen`: a person a source of the organization saw (an assignee, a colleague): every alias but
 *   those made only of common words («Costo» of «Marco Costo», a name «Budget»);
 * - `untrusted`: a name someone outside the organization chose or wrote (a mail header, a
 *   mention, a guest, a customer account): the full name without the suffixes clients add, in
 *   both orders, and its parts only where the text writes them with a capital; only a name of at
 *   least two words of letters, none common (particles aside). Anything else is never
 *   registered: anyone could name themselves «budget» or «Budget Rischio».
 */
export type PersonTrust = 'seen' | 'untrusted'

export interface KnownPerson {
  displayName: string
  email?: string
  trust?: PersonTrust
  /**
   * `organization`: a company, a customer or a project to hide as [ORG_n] (its name as written,
   * in any case; never its parts alone). Absent: a person.
   */
  kind?: 'organization'
}

// Word characters for boundaries: letters, numbers and combining marks. "_" is NOT one, so
// mario_rossi is matched.
const W = String.raw`\p{L}\p{N}\p{M}`

// Strict email: bounded quantifiers and a left boundary keep matching linear on hostile input.
// The right boundary stops it from matching only a prefix of a longer address.
const EMAIL_STRICT =
  String.raw`(?<![${W}._%+-])[${W}._%+-]{1,64}@(?:[${W}-]{1,63}\.){1,8}\p{L}{2,24}` +
  String.raw`(?![${W}@-]|\.[${W}])`

// Fail-closed email fallback. It starts only at the beginning of a whitespace/semicolon
// delimited run (so it stays linear) and takes: a quoted or unquoted local part (anything but
// whitespace, "@", semicolon; a comma is allowed, so "a,b@x.it" is one address; a quoted one may
// also follow a comma), "@", then the
// rest of the run (or a bracketed host), without trailing punctuation. Odd local parts and repeated "@" end up in one token.
const EMAIL_LOOSE =
  String.raw`(?:(?<![^\s,;])"[^"\r\n]{1,64}"|(?<![^\s;])[^\s@;]+)@` +
  String.raw`(?:\[[^\]\r\n]{1,64}\]|\S*[^\s.,;:!?)>"'])`

// Real dates and times only (ranges checked); date-shaped text that is not a real date can be
// part of a phone number. Dates and times are protected (returned unchanged).
const DAY = String.raw`(?:0?[1-9]|[12]\d|3[01])`
const MONTH = '(?:0?[1-9]|1[0-2])'
const YEAR = String.raw`(?:19|20)\d{2}`
const REAL_DATE_OR_TIME =
  String.raw`${YEAR}[-./]${MONTH}[-./]${DAY}(?!\d)|${DAY}[-./]${MONTH}[-./]${YEAR}(?!\d)` +
  String.raw`|(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)`
// Dotted Italian times (10.30) are protected only after ore/alle/dalle/h.
const DOTTED_TIME = String.raw`(?<=\b(?:ore|alle|dalle|h)\s{0,3})(?:[01]?\d|2[0-3])\.[0-5]\d(?!\d)`
const PROTECTED = `${REAL_DATE_OR_TIME}|${DOTTED_TIME}`
/** A protected date or time that starts exactly at `lastIndex`. */
const PROTECTED_AT = new RegExp(PROTECTED, 'iuy')

// Phone: optional +/00 prefix, at least 8 decimal digits (any script: fullwidth, Arabic-Indic...)
// in groups separated by up to three of: any space separator (Zs) or tab, . / the hyphens, dashes
// and minus U+2010..U+2014, U+2212, and the invisible soft hyphen, zero-width space/joiners,
// word joiner and BOM; "(0)" groups allowed, no upper limit (fail closed). Line breaks do not
// join digits. After a space a real date or time ends the candidate, so "12 04.11.2026" is a
// number and a date.
const DIGIT = String.raw`(?:\(\p{Nd}{1,4}\)|\p{Nd})`
const SPACES = String.raw`[\p{Zs}\t]`
const PHONE_SEP = '[\\p{Zs}\\t.\\-\\u2010-\\u2014\\u2212/\\u00ad\\u200b-\\u200d\\u2060\\ufeff]'
const PHONE = String.raw`(?:\+|00)?${DIGIT}(?:${PHONE_SEP}{0,3}(?:(?<!${SPACES})|(?!${REAL_DATE_OR_TIME}))${DIGIT}){7,}`

// --- meetings, identifiers and domains ------------------------------------------------------
//
// An invitation to a meeting carries what lets anyone in: the join link (with the tenant and the
// organizer in its `context`), the dial-in link, the passcode, the PIN and the ids of the meeting.
// They are hidden whole, before the phone numbers, so that no piece of them is left in clear.

/** The hosts of the meeting services (Teams, Webex, Zoom, Meet and others). */
const MEETING_HOSTS = String.raw`(?:teams\.microsoft\.com|teams\.live\.com|webex\.com|zoom\.us|zoomgov\.com|meet\.google\.com|gotomeeting\.com|gotomeet\.me|whereby\.com|meet\.jit\.si|bluejeans\.com)`
/** The parameters of a link that let into a meeting, on any host. */
const MEETING_PARAMS = '[?&;](?:tenantkey|confid|conf_id|pwd|passcode|meetingid)='
/** What a link is made of: anything but spaces, quotes and angle brackets. */
const URL_CHAR = '[^\\s<>"\'\\u0060]'
/** A link does not end with the punctuation of the sentence around it. */
const URL_END = String.raw`(?<![.,;:!?)\]])`
/**
 * A link to join a meeting, whole: one that starts with a scheme or «www.» and holds a meeting host
 * or parameter within its first 512 characters (a safe-links wrapper included), or one written
 * from its host. At most 4,096 characters; the look-ahead is bounded, so the scan stays linear.
 */
const MEETING_LINK =
  String.raw`(?:https?:\/\/|www\.)(?=${URL_CHAR}{0,512}?(?:${MEETING_HOSTS}|${MEETING_PARAMS}))${URL_CHAR}{1,4096}${URL_END}` +
  String.raw`|(?<![\w.@/%-])(?:[\w-]{1,63}\.){0,4}${MEETING_HOSTS}(?:[/?#%:]${URL_CHAR}{0,4096}${URL_END})?`
/** The words before a code of a meeting (Italian and English). */
const MEETING_LABEL = String.raw`(?<![\p{L}\p{N}])(?:passcode|pin(?:\s{1,3}code)?|codice\s{1,3}pin|(?:meeting\s{1,3})?password(?:\s{1,3}(?:della\s{1,3})?riunione)?|id\s{1,3}(?:della\s{1,3})?riunione|id\s{1,3}(?:della\s{1,3})?conferenza(?:\s{1,3}telefonica)?|id\s{1,3}video|id\s{1,3}(?:della\s{1,3})?chiamata|id\s{1,3}partecipante|meeting\s{1,3}(?:id|number)|conference\s{1,3}id|video\s{1,3}(?:conference\s{1,3})?id|vtc\s{1,3}conference\s{1,3}id|access\s{1,3}code|attendee\s{1,3}id|participant\s{1,3}id|codice\s{1,3}(?:di\s{1,3}|d(?:['’ʼ‘]\s{0,2}|\s{0,2}))accesso|codice\s{1,3}(?:della\s{1,3})?(?:riunione|conferenza)|numero\s{1,3}(?:della\s{1,3})?riunione|tenant\s?key|host\s{1,3}key|chiave\s{1,3}(?:dell['’ʼ‘]\s{0,2})?host|pwd|chiave\s{1,3}(?:del\s{1,3})?tenant)`
/** A code: letters, digits, «#» and «*», or groups of digits («123 456 789 012», «1234567#»). */
const CODE_VALUE = String.raw`[\p{L}\p{N}][\p{L}\p{N}#*]{0,63}(?:[\p{Zs}.-]\p{N}[\p{N}#*]{0,15}){0,8}`
/**
 * The value of a code of a meeting, without its label: after a «:» or «=» any value, after spaces
 * only a value with a digit («ID riunione 123 456», never «PIN della banca»).
 */
const MEETING_CODE =
  String.raw`(?<=${MEETING_LABEL}\s{0,3}(?:\([^)\n]{0,20}\)\s{0,3})?[:=]\s{0,3})${CODE_VALUE}` +
  String.raw`|(?<=${MEETING_LABEL}[\p{Zs}\t]{1,3})(?=[^\s]{0,64}\p{N})${CODE_VALUE}`
/**
 * A GUID or a long token, whole: what follows «Bearer», a JWT (its three parts), a token with the
 * prefix of a known service («ghp_», «github_pat_», «npm_», «glpat-», «xoxb-», «sk-», «AKIA») and
 * 16 characters or more after it, the shape of a GUID, or a
 * run of at least 16 characters that is
 * hexadecimal with dashes (a letter and a digit in it) or of letters and digits with a letter
 * after a digit. A run of digits only stays a number, a name glued to a number
 * («mrossi7933312345») stays a name and a number, and a word with dashes
 * («end-to-end-test-2026») is neither.
 */
const LONG_ID =
  String.raw`(?<=(?<![\p{L}\p{N}])bearer[ \t]{1,3})[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-])|` +
  String.raw`(?<![A-Za-z0-9_-])(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_|npm_|glpat-|xox[abprs]-|sk-(?:proj-|ant-)?|AKIA)[A-Za-z0-9_-]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}` +
  String.raw`|(?=[A-Za-z0-9_-]{16})(?:(?=[0-9a-f-]*[a-f])(?=[0-9a-f-]*\d)[0-9a-f]+(?:-[0-9a-f]+)+` +
  String.raw`|(?=[A-Za-z]*\d+[A-Za-z])[A-Za-z0-9]+))(?![A-Za-z0-9_-])`
/** The domains of the countries and the generic ones a company's site or mail is under. */
const TLD = '(?:com|it|eu|net|org|io|de|fr|ch|es|uk|co|biz|info|cloud|app|dev|tech|ai)'
/**
 * A domain written in the text («acme-logistica.it», «www.acme.com»), not in an address: hidden as
 * an organization. Labels of letters, digits and dashes, at most four before the domain.
 */
const DOMAIN =
  String.raw`(?<![\p{L}\p{N}\p{M}@._%+-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.){1,4}${TLD}` +
  String.raw`(?![\p{L}\p{N}\p{M}-]|\.[\p{L}\p{N}])`

// Text that already looks like one of our tokens is escaped so that restore stays exact.
const TOKEN_SOURCE = String.raw`\[(?:PERSONA_AMBIGUA|PERSONA|EMAIL|TELEFONO|LITERAL|ORG|LINK_RIUNIONE|CODICE_RIUNIONE|ID)_\d+[A-Z]*\]`
const TOKEN = new RegExp(TOKEN_SOURCE, 'g')
/** The placeholders of the index-free mode, one per kind of hidden text. */
const INDEX_FREE = {
  person: '[PERSONA]',
  ambiguous: '[PERSONA]',
  org: '[ORG]',
  email: '[EMAIL]',
  phone: '[TELEFONO]',
  literal: '[LITERAL]',
  link: '[LINK_RIUNIONE]',
  code: '[CODICE_RIUNIONE]',
  id: '[ID]',
  domain: '[ORG]',
} as const

/** The kinds of placeholder, as the preview counts them. */
export const PLACEHOLDER_KINDS = [
  'PERSONA',
  'PERSONA_AMBIGUA',
  'EMAIL',
  'TELEFONO',
  'LINK_RIUNIONE',
  'CODICE_RIUNIONE',
  'ID',
  'ORG',
  'LITERAL',
] as const
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number]

/** The placeholders that carry a credential: never put back in clear in a model's answer. */
const CREDENTIAL_TOKEN = /^\[(?:LINK_RIUNIONE|CODICE_RIUNIONE)_/u

/**
 * How many distinct placeholders of each kind a pseudonymized text holds: the same token counts
 * once, and so do the spellings of one person or organization ([PERSONA_1], [PERSONA_1A]). What
 * the preview of STOP S4 shows, never the text.
 */
export function placeholderCounts(text: string): Record<PlaceholderKind, number> {
  const counts = Object.fromEntries(PLACEHOLDER_KINDS.map((k) => [k, 0])) as Record<
    PlaceholderKind,
    number
  >
  const bases = new Set((text.match(TOKEN) ?? []).map((t) => t.replace(/[A-Z]*\]$/u, '')))
  for (const base of bases) {
    const kind = base.slice(1, base.lastIndexOf('_')) as PlaceholderKind
    counts[kind] += 1
  }
  return counts
}

type FixedKind = 'email' | 'literal' | 'link' | 'code' | 'id' | 'date' | 'domain' | 'phone'

/** The recognizers that do not depend on the people, in order of precedence at one position. */
const FIXED_KINDS: FixedKind[] = [
  'email',
  'email',
  'literal',
  'link',
  'code',
  'id',
  'date',
  'domain',
  'phone',
]
const FIXED = new RegExp(
  [
    EMAIL_STRICT,
    EMAIL_LOOSE,
    TOKEN_SOURCE,
    MEETING_LINK,
    MEETING_CODE,
    LONG_ID,
    PROTECTED,
    DOMAIN,
    PHONE,
  ]
    .map((s) => `(${s})`)
    .join('|'),
  'giu',
)
/**
 * What ends the rest of a number cut by a name («mrossi79 3331234567@contoso.it»): an email or a
 * token-shaped text, which win over a number. A date or time inside the rest does not end it:
 * the number recognizer already decided those digits belong to the number, as in a scan of the
 * number alone, so none of them is left in clear.
 */
const NOT_PHONE_SOURCE = [EMAIL_STRICT, EMAIL_LOOSE, TOKEN_SOURCE].map((s) => `(?:${s})`).join('|')
/** The end of the rest of a number: its last digit or bracket. */
const PHONE_TAIL_END = /[\p{Nd})]$/u

const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const LETTER = /\p{L}/u
/** What joins the words of a name: spaces (any, line breaks too), dot, underscore, dash, apostrophes. */
const SEPARATOR = /[\s._'’-]/u
const NAME_SPLIT = /[\s._'’-]+/

const MIN_PART_LENGTH = 3

/** Most distinct names one dictionary holds: beyond it the people are refused (fail closed). */
export const MAX_DICTIONARY_PEOPLE = 50_000
/** Most word runs of a name matched as a whole; a longer name is matched by its first ones. */
const MAX_ALIAS_RUNS = 32
/** Longest name of one run found glued to a number that starts inside its word. */
const MAX_GLUED = 64
/** Longest punctuation kept at the edges of a name written as is ("(Jo)"); longer is dropped. */
const MAX_EDGE = 8

// --- case folding -------------------------------------------------------------------------

const foldCache = new Map<string, string>()

/**
 * Simple case folding of one code point: the lower case of its upper case when both are one code
 * point («ς» and «σ» are the same letter), else its lower case when that is one code point, else
 * the code point itself («İ» keeps its length and matches only itself). Never accents.
 */
function foldPoint(c: string): string {
  const cached = foldCache.get(c)
  if (cached !== undefined) return cached
  const single = (s: string) => s.length > 0 && String.fromCodePoint(s.codePointAt(0) ?? 0) === s
  const upper = c.toUpperCase()
  let out = c
  if (single(upper) && single(upper.toLowerCase())) out = upper.toLowerCase()
  else if (single(c.toLowerCase())) out = c.toLowerCase()
  if (foldCache.size < 100_000) foldCache.set(c, out)
  return out
}

function fold(s: string): string {
  let out = ''
  for (const c of s) out += foldPoint(c)
  return out
}

// --- the words of a name ------------------------------------------------------------------

/** The words of a name (NFC), as written and without surrounding quotes or brackets. */
function splitName(name: string): { rawWords: string[]; words: string[] } {
  const rawWords = name
    .normalize('NFC')
    .split(NAME_SPLIT)
    .filter((w) => w.length > 0)
  // Parts are also registered without surrounding quotes/brackets ("Nana" -> Nana).
  const words = rawWords
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w.length > 0)
  return { rawWords, words }
}

function isSeparator(c: string): boolean {
  return SEPARATOR.test(c)
}

/**
 * The key of the text between two word runs, as the dictionary stores it: the text case-folded,
 * each run of separators (any number of spaces, dots, underscores, dashes, apostrophes) as one
 * NUL. «Rossi Anna» and «Rossi.Anna» have the same gap, «Rossi, Anna» another, «Jean+Paul» a
 * gap without separators, «Li & Xu» one with punctuation between two separators.
 */
function gapKey(gap: string): string {
  let out = ''
  let inSeparators = false
  for (const c of gap) {
    if (isSeparator(c)) {
      if (!inSeparators) out += '\u0000'
      inSeparators = true
    } else {
      out += foldPoint(c)
      inSeparators = false
    }
  }
  return out
}

interface Alias {
  lead: string
  runs: string[]
  gaps: string[]
  trail: string
}

/**
 * A sequence of words of a name as runs of word characters, the gaps between them and the
 * punctuation at its edges, all case-folded. A word without any letter or digit («&», «–») is
 * punctuation of the gap it stands in, or dropped at the edges. A name of more than
 * `MAX_ALIAS_RUNS` runs becomes a chain of aliases of at most that many runs each, so that every
 * word of it is matched. Empty when it cannot be matched (edges too long, no letter at all).
 */
function aliasesOf(words: readonly string[]): Alias[] {
  const runs: string[] = []
  const gaps: string[] = []
  let lead = ''
  let pending = ''
  for (const word of words) {
    const found = [...word.matchAll(WORD_RUN)]
    if (found.length === 0) {
      // Punctuation alone: part of the gap, if there is one on both sides.
      if (runs.length > 0) pending += `\u0000${fold(word)}`
      continue
    }
    const first = found[0] as RegExpExecArray
    const before = word.slice(0, first.index)
    if (runs.length === 0) lead = before
    else gaps.push(`${pending}\u0000${fold(before)}`)
    found.forEach((m, k) => {
      if (k > 0) {
        const prev = found[k - 1] as RegExpExecArray
        gaps.push(fold(word.slice(prev.index + prev[0].length, m.index)))
      }
      runs.push(fold(m[0]))
    })
    const last = found[found.length - 1] as RegExpExecArray
    pending = fold(word.slice(last.index + last[0].length))
  }
  // Punctuation words after the last run are no part of the name.
  const trail = pending.includes('\u0000') ? pending.slice(0, pending.indexOf('\u0000')) : pending
  if (runs.length === 0 || !runs.some((r) => LETTER.test(r))) return []
  if (lead.length > MAX_EDGE || trail.length > MAX_EDGE) return []
  const chain: Alias[] = []
  for (let from = 0; from < runs.length; from += MAX_ALIAS_RUNS) {
    const to = Math.min(from + MAX_ALIAS_RUNS, runs.length)
    const piece = {
      lead: from === 0 ? fold(lead) : '',
      runs: runs.slice(from, to),
      gaps: gaps.slice(from, to - 1),
      trail: to === runs.length ? trail : '',
    }
    if (piece.runs.some((r) => LETTER.test(r))) chain.push(piece)
  }
  return chain
}

// --- the dictionary -----------------------------------------------------------------------

/** The common words of every language, case-folded: never a name on their own. */
const COMMON = new Set(
  LANGS.flatMap((lang) => {
    const v = vocabulary(lang)
    return [...v.COMMON_WORDS, ...v.NAME_PARTICLES, ...v.NOT_PERSON_WORDS].map((w) =>
      fold(w.normalize('NFC')),
    )
  }),
)

/** The words of a candidate alias that carry a letter: a number is never a word of a name. */
const letteredWords = (words: readonly string[]) => words.filter((w) => LETTER.test(w))

/** Whether every word of a candidate alias with a letter is a common word (or none has one). */
function onlyCommon(words: readonly string[]): boolean {
  return letteredWords(words).every((w) => COMMON.has(fold(w)))
}

/** A letter in upper case: how a name is written at its start. */
const CAPITAL = /^\p{Lu}/u

/** A word of letters (and marks) only: no digit, no other sign inside. */
const ALPHABETIC = /^[\p{L}\p{M}]+$/u
/** The particles of names of every language, case-folded («De», «Della», «van»). */
const PARTICLES = new Set(
  LANGS.flatMap((lang) => [...vocabulary(lang).NAME_PARTICLES].map((w) => fold(w))),
)
/** A name without its digits, one space between words («Rossi2» → «Rossi»). */
const withoutDigits = (name: string) =>
  name
    .replace(/\p{Nd}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

/** A word without its diacritics (NFD, no combining marks, back to NFC). */
const withoutMarks = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')

/**
 * The parts of a name written with a hyphen, also joined («Mariagrazia» of «Maria-Grazia»), as
 * single parts.
 */
function joinedParts(core: string): string[][] {
  const out: string[][] = []
  for (const m of core.matchAll(/(\p{L}+)[-\u2010](\p{L}+)/gu)) {
    out.push([`${m[1]}${m[2]}`])
  }
  return out
}

/** The words of a piece of a display name that are not particles. */
const namedWords = (piece: string) => splitName(piece).words.filter((w) => !isParticle(w))

/** A particle of a name, or a letter left by an elision («D» of «D'Amico»). */
const isParticle = (word: string) => PARTICLES.has(fold(word)) || [...word].length === 1

/**
 * What of a name chosen outside the organization may be registered, or null when nothing may:
 * its words must be letters only, with at least two that are not particles and none of those a
 * common word («Budget Rischio», «giorni 45», «M3 Sprint», one word: never). Then the full name
 * as written and in the other order («Giulia Verdi» of «Verdi, Giulia», «Carla Bianchi» of
 * «BIANCHI Carla»), and each part of at least 3 letters (`parts`), which only matches written
 * with a capital («Fantini conferma», never «il progetto è rinviato» for «Rinviato Neri»).
 */
function untrustedForms(displayName: string): { full: string[][]; parts: string[] } | null {
  const core = displayCore(displayName)
  // «Cognome, Nome» (a word on each side, particles aside) is a name in two halves; otherwise
  // what follows the first «,» or «/» is not the name («Mario Rossi, Ufficio Acquisti»).
  const pieces = core
    .split(/[,/]/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (pieces.length === 0) return null
  const [first, second] = pieces as [string, string | undefined]
  const halves =
    second !== undefined && namedWords(first).length === 1 && namedWords(second).length === 1
  const written = splitName(halves ? `${first}, ${second}` : first)
  let { rawWords, words } = written
  // A trailing number is no part of a name («Mario Rossi 2»).
  if (words.length > 0 && /^\p{Nd}+$/u.test(words[words.length - 1] as string)) {
    words = words.slice(0, -1)
    rawWords = rawWords.slice(0, -1)
  }
  if (!words.every((w) => ALPHABETIC.test(w))) return null
  const named = words.filter((w) => !isParticle(w))
  // Two words that are not particles, one at least not a common word («Bloccato Ferri», never
  // «Budget Rischio»): the common one is never registered alone.
  const uncommon = named.filter((w) => !COMMON.has(fold(w)))
  if (named.length < 2 || uncommon.length === 0) return null
  const full: string[][] = [rawWords, words]
  if (halves) {
    full.push([...splitName(second as string).words, ...splitName(first).words])
  } else if (words.length === 2) {
    full.push([words[1] as string, words[0] as string])
  }
  // A surname with its particle («De Luca» of «Francesca De Luca»).
  const particle = words.findIndex((w, k) => k > 0 && k < words.length - 1 && isParticle(w))
  if (particle > 0) full.push(words.slice(particle))
  const parts = [...new Set(uncommon.filter((w) => [...w].length >= MIN_PART_LENGTH))]
  return { full, parts }
}

/**
 * Who a name is, whatever its order and what a client adds after it: its words without the
 * particles, case-folded and sorted («Rossi, Mario», «Mario Rossi» and «ROSSI Mario (Acme)» are
 * one person). Two entries of the list with one identity are one person.
 */
function personIdentity(displayName: string): string {
  const words = namedWords(displayCore(displayName).replace(/[,/]/gu, ' ')).map((w) => fold(w))
  return `person:${words.sort().join(' ')}`
}

/** The name of an organization without its legal form at the end («Acme» of «Acme S.p.A.»). */
function withoutCompanyForm(name: string): string {
  const core = name.normalize('NFC').trim()
  const form = COMPANY_FORM.exec(core)
  return form && form.index > 0 ? core.slice(0, form.index).replace(/[\s,]+$/u, '') : core
}

/** The forms of a name the answer check counts: in any case, and only written with a capital. */
export interface NameForms {
  forms: string[]
  capitalForms: string[]
}

/**
 * The forms of a person's name the answer check counts as naming them, with the same trust as
 * the dictionary: every part of 3 letters or more and the email for a member; no form made only
 * of common words for a person a source saw; for an outsider, what `untrustedForms` allows (its
 * parts only written with a capital) and the email.
 */
export function knownNameForms(person: KnownPerson): NameForms {
  if (typeof person.displayName !== 'string' || person.kind === 'organization') {
    return { forms: [], capitalForms: [] }
  }
  if (person.trust === 'untrusted') {
    const found = untrustedForms(person.displayName)
    const email = person.email ? [person.email] : []
    return found
      ? { forms: [...found.full.map((f) => f.join(' ')), ...email], capitalForms: found.parts }
      : { forms: email, capitalForms: [] }
  }
  const parts = person.displayName
    .split(/[\s'’-]+/u)
    .filter((p) => [...p.replace(/[^\p{L}]/gu, '')].length >= MIN_PART_LENGTH)
  const all = [person.displayName, ...parts, ...(person.email ? [person.email] : [])]
  const forms =
    person.trust === 'seen'
      ? all.filter((f) => f.includes('@') || !onlyCommon(splitName(f).words))
      : all
  return { forms, capitalForms: [] }
}

/** The key of a gap that is only separators: the common case, kept apart from the others. */
const PLAIN_GAP = '\u0000'
/** Most names written with punctuation at their edges ending at one node. */
const MAX_EDGE_NAMES = 16

interface Node {
  /** A name ends here, written without punctuation at its edges: its owner. */
  owner?: number
  /**
   * A part of an outsider's name, or a short form of a first name, ends here: its owner, when the
   * text writes it with a capital or at the start of a turn of speech and no other owner has the
   * alias.
   */
  capitalOwner?: number
  /** The identity of the first person (or organization) one word alone ending here names. */
  identity?: string
  /** One word alone that names people of different identities: an ambiguous placeholder. */
  ambiguous?: true
  /** A short form of a first name that is also a common word: hidden only as a word-name is. */
  guarded?: true
  /** Names ending here written with punctuation at their edges («(Jo)»). */
  edges?: { lead: string; trail: string; owner: number }[]
  /** After this run, past a gap of separators only: the next runs. */
  plain?: Map<string, Node>
  /** After this run, past any other gap: the next runs, by the key of the gap. */
  gaps?: Map<string, Map<string, Node>>
}

/**
 * The names of a set of people, compiled once: a dictionary of their words, matched word by word
 * in linear time. It holds no state of a text; many `Pseudonymizer`s share one (the same people).
 *
 * Per person (owner = position in the list + 1): the name as written, its words without the
 * punctuation around them, each of those words alone when at least 3 characters long, a name of
 * two words with a shorter one in the other order too, and the user name of the email (before
 * "@") the same way when at least 3 characters long; less for a person whose name is trusted
 * less (`PersonTrust`). An alias
 * without any letter is never registered: numbers are not names. The first person with an alias
 * keeps it. More than `MAX_DICTIONARY_PEOPLE` distinct names is refused with
 * `pseudonymization_unavailable`.
 */
export class PeopleMatcher {
  private readonly root = new Map<string, Node>()
  /** The lengths of the names of one run, longest first, at most `MAX_GLUED`. */
  private gluedLengths: number[] = []

  constructor(people: readonly KnownPerson[]) {
    const distinct = new Set<string>()
    for (const person of people) {
      const name = typeof person.displayName === 'string' ? person.displayName.trim() : ''
      if (name !== '') distinct.add(fold(name.normalize('NFC')))
    }
    if (distinct.size > MAX_DICTIONARY_PEOPLE) throw new DomainError('pseudonymization_unavailable')
    const longParts = (words: string[]) =>
      words.filter((w) => w.length >= MIN_PART_LENGTH).map((w) => [w])
    // A name of two words with a short part («Li Xu») is also written the other way round
    // («Xu Li»): its parts are too short to be registered alone.
    const reversed = (words: string[]) =>
      words.length === 2 && words.some((w) => w.length < MIN_PART_LENGTH)
        ? [[words[1] as string, words[0] as string]]
        : []
    people.forEach((person, index) => {
      if (typeof person.displayName !== 'string') return
      const { rawWords, words } = splitName(person.displayName)
      if (words.length === 0) return
      const owner = index + 1
      if (person.kind === 'organization') {
        // An organization: its name as written, and without its legal form («Acme Logistica»
        // of «Acme Logistica S.p.A.»), in any case; never one of its words alone.
        this.organizations.add(owner)
        const core = withoutCompanyForm(person.displayName)
        this.identities.set(owner, `org:${fold(core)}`)
        for (const candidate of [rawWords, words, splitName(core).words]) {
          if (candidate.length > 0) this.add(candidate, owner)
        }
        return
      }
      this.identities.set(owner, personIdentity(person.displayName))
      const trust = person.trust
      const kept = (candidate: string[]) => trust !== 'seen' || !onlyCommon(candidate)
      // The name without its decorations («[EXT]», «<address>», « - Team X», «(Admin)»,
      // digits) is registered word by word; then every piece of the decorations that holds a
      // word of a name («Helpdesk - Mario Rossi», «Support (Mario Rossi)», «[Mario Rossi]»): a
      // person is never lost inside a decoration. Only a name of another source whose every word
      // is a group, a role or a common word («Team Delivery», «[PORTALE]») registers nothing but
      // the user name of its address; a member's name is always a person's.
      const core = personNameCore(person.displayName)
      // Digits glued to a name («Rossi2») are no part of it for the words alone.
      const lettered = withoutDigits(core)
      const pieces = nameSegments(person.displayName)
        .map(withoutDigits)
        .filter((piece) => piece !== '' && piece !== lettered && piece !== core)
      if (trust === undefined || notAPersonReason(person.displayName) === null) {
        if (trust === 'untrusted') {
          // The full name in both orders, and its parts and short forms only written with a
          // capital (or at the start of a turn); never the email, never a name that is not one.
          for (const piece of [lettered, ...pieces]) {
            const forms = untrustedForms(piece)
            if (!forms) continue
            for (const candidate of forms.full) this.add(candidate, owner)
            for (const part of forms.parts) this.add([part], owner, true)
            this.addFirstNameVariants(piece, owner, trust)
          }
          return
        }
        // A part alone that is a word of a group («Helpdesk» of «Helpdesk - Mario Rossi») is
        // not hidden for a source's name, nor for a member's written with decorations; a
        // member's plain name keeps every part («Anna Area»).
        const decorated = pieces.length > 0
        // A part of a plain name a source saw that is a word of a role, not a common word
        // («Product», «Lead» of «Mario Product»): hidden only written with a capital, as an
        // outsider's part is.
        const roleSurname = (candidate: string[]) =>
          trust === 'seen' &&
          !decorated &&
          candidate.length === 1 &&
          [...(candidate[0] ?? '')].length >= MIN_PART_LENGTH &&
          isGroupWord(candidate[0] ?? '') &&
          !COMMON.has(fold(candidate[0] ?? ''))
        const keptPart = (candidate: string[]) =>
          kept(candidate) &&
          (candidate.length > 1 ||
            (trust === undefined && !decorated) ||
            !(trust === undefined ? isGroupWord : isGroupOrCommonWord)(candidate[0] ?? ''))
        const own = splitName(core)
        // The name as written, whole, keeps matching with its decorations («Mario Rossi (Admin)»).
        for (const candidate of [rawWords, words]) {
          if (candidate.length > 1 && kept(candidate)) this.add(candidate, owner)
        }
        for (const candidate of [
          own.rawWords,
          own.words,
          ...reversed(own.words),
          ...longParts(own.words),
          ...joinedParts(core),
        ]) {
          if (keptPart(candidate)) this.add(candidate, owner)
          else if (roleSurname(candidate)) this.add(candidate, owner, true)
        }
        if (lettered !== core) {
          const plain = splitName(lettered).words
          for (const candidate of [plain, ...longParts(plain)]) {
            if (candidate.length > 0 && keptPart(candidate)) this.add(candidate, owner)
            else if (roleSurname(candidate)) this.add(candidate, owner, true)
          }
        }
        this.addFirstNameVariants(lettered, owner, trust)
        // The pieces of the decorations: their words of a name, alone and together.
        for (const piece of pieces) {
          const pieceWords = splitName(piece).words
          const named = pieceWords.filter(
            (w) => [...w].length >= MIN_PART_LENGTH && LETTER.test(w) && !isGroupOrCommonWord(w),
          )
          if (named.length === 0) continue
          if (pieceWords.length > 1) this.add(pieceWords, owner)
          for (const w of named) this.add([w], owner)
          for (const candidate of joinedParts(piece)) this.add(candidate, owner)
          this.addFirstNameVariants(piece, owner, trust)
        }
      } else if (trust === 'untrusted') {
        return
      }
      // The user name of the person's email is the person too, also without the domain
      // ("@obrambilla"): whole, and its parts, when at least as long as a name part.
      const at = typeof person.email === 'string' ? person.email.lastIndexOf('@') : -1
      if (at <= 0) return
      const user = splitName((person.email as string).slice(0, at)).words
      if (user.join('').length < MIN_PART_LENGTH) return
      for (const candidate of [user, ...longParts(user)]) {
        if (kept(candidate)) this.add(candidate, owner)
      }
    })
  }

  /** The owners that are organizations, not people. */
  private readonly organizations = new Set<number>()
  /** The identity of each owner: the same person listed twice (a member, a source) is one. */
  private readonly identities = new Map<number, string>()

  /** Whether an owner is an organization. */
  isOrganization(owner: number): boolean {
    return this.organizations.has(owner)
  }

  /**
   * The short forms of the first names of a person known by at least two words («Andre»,
   * «Clau», «Peppe», of any word of the name the table knows: «Rossi Mario» too): only written
   * with a capital or at the start of a turn, a common word among them only as a word-name
   * (`WORD_NAMES`). A person a source saw never gets a common word.
   */
  private addFirstNameVariants(core: string, owner: number, trust?: PersonTrust): void {
    const named = namedWords(core.replace(/[,/]/gu, ' '))
    if (named.length < 2) return
    for (const word of named) {
      for (const variant of firstNameVariants(word)) {
        const common = COMMON.has(fold(variant)) || WORD_NAMES.has(variant)
        if (common && trust === 'seen') continue
        this.add([variant], owner, true, common)
      }
    }
  }

  private add(words: readonly string[], owner: number, capitalOnly = false, guarded = false): void {
    // A name written with accents is also written without («Nicolò» as «Nicolo», «NICOLO»).
    const plain = words.map((w) => withoutMarks(w))
    const forms = plain.some((w, k) => w !== words[k]) ? [words, plain] : [words]
    for (const form of forms) this.addForm(form, owner, capitalOnly, guarded)
  }

  private addForm(
    words: readonly string[],
    owner: number,
    capitalOnly: boolean,
    guarded: boolean,
  ): void {
    for (const alias of aliasesOf(words)) {
      // A part written with a capital is one run, without punctuation at its edges.
      if (capitalOnly && (alias.runs.length !== 1 || alias.lead !== '' || alias.trail !== '')) {
        continue
      }
      this.addAlias(alias, owner, capitalOnly, guarded)
    }
  }

  private addAlias(alias: Alias, owner: number, capitalOnly = false, guarded = false): void {
    let level = this.root
    let node: Node | undefined
    alias.runs.forEach((run, i) => {
      if (i > 0 && node) {
        const gap = alias.gaps[i - 1] as string
        if (gap === PLAIN_GAP) {
          node.plain ??= new Map()
          level = node.plain
        } else {
          node.gaps ??= new Map()
          let next = node.gaps.get(gap)
          if (!next) {
            next = new Map()
            node.gaps.set(gap, next)
          }
          level = next
        }
      }
      let found = level.get(run)
      if (!found) {
        found = {}
        level.set(run, found)
      }
      node = found
    })
    if (!node) return
    if (alias.runs.length === 1 && alias.lead === '' && alias.trail === '') {
      // One word alone: a first name, a surname, a short form. Claimed by two identities, it
      // names neither for sure: ambiguous, never the pseudonym of one of them.
      const identity = this.identities.get(owner) ?? `owner:${owner}`
      if (node.identity === undefined) node.identity = identity
      else if (node.identity !== identity) node.ambiguous = true
      if (guarded) node.guarded = true
    }
    if (capitalOnly) {
      node.capitalOwner ??= owner
      return
    }
    if (alias.lead === '' && alias.trail === '') {
      node.owner ??= owner
      const length = (alias.runs[0] as string).length
      if (alias.runs.length === 1 && length <= MAX_GLUED && !this.gluedLengths.includes(length)) {
        this.gluedLengths = [...this.gluedLengths, length].sort((x, y) => y - x)
      }
      return
    }
    node.edges ??= []
    if (node.edges.length >= MAX_EDGE_NAMES) return
    if (node.edges.some((e) => e.lead === alias.lead && e.trail === alias.trail)) return
    node.edges.push({ lead: alias.lead, trail: alias.trail, owner })
  }

  /**
   * The longest name of one run that starts the word at `wordStart` and ends between `from` and
   * `to` (a name glued to a number: «Rossi12345678», «mrossi7933312345»); null when none does.
   */
  prefixAt(
    text: string,
    wordStart: number,
    from: number,
    to: number,
  ): { start: number; end: number; owner: number } | null {
    for (const length of this.gluedLengths) {
      const end = wordStart + length
      if (end < from || end > to) continue
      const owner = this.root.get(fold(text.slice(wordStart, end)))?.owner
      if (owner !== undefined) return { start: wordStart, end, owner }
    }
    return null
  }

  /**
   * The names in `text` between `from` and `to` (the gaps left by the other recognizers): left
   * to right, the leftmost first and the longest at one position, never overlapping. Word runs
   * that touch the edge of the gap are not names (they continue into an email or a number).
   */
  find(text: string, from: number, to: number): NameMatch[] {
    const out: NameMatch[] = []
    if (this.root.size === 0 || from >= to) return out
    const slice = text.slice(from, to)
    const runs: { start: number; end: number }[] = []
    for (const m of slice.matchAll(WORD_RUN)) {
      const start = from + m.index
      const end = start + m[0].length
      // A run cut by the edge of the gap is part of a word outside it.
      if (start === from && from > 0 && wordCharBefore(text, from)) continue
      if (end === to && to < text.length && WORD_CHAR.test(codePointAt(text, to))) continue
      runs.push({ start, end })
    }
    const folded: (string | undefined)[] = []
    const gapKeys: (string | undefined)[] = []
    const foldedRun = (i: number) => {
      let f = folded[i]
      if (f === undefined) {
        const r = runs[i] as { start: number; end: number }
        f = fold(text.slice(r.start, r.end))
        folded[i] = f
      }
      return f
    }
    const gapAfter = (i: number) => {
      let g = gapKeys[i]
      if (g === undefined) {
        const a = runs[i] as { end: number }
        const b = runs[i + 1] as { start: number }
        g = gapKey(text.slice(a.end, b.start))
        gapKeys[i] = g
      }
      return g
    }
    let cursor = from
    for (let i = 0; i < runs.length; i += 1) {
      const first = runs[i] as { start: number; end: number }
      if (first.start < cursor) continue
      let best: Found | null = null
      const consider = (
        start: number,
        end: number,
        owner: number,
        last: number,
        ambiguous = false,
      ) => {
        if (!best || start < best.start || (start === best.start && end > best.end)) {
          best = { start, end, owner, last, ...(ambiguous ? { ambiguous: true as const } : {}) }
        }
      }
      let node = this.root.get(foldedRun(i))
      let j = i
      while (node) {
        const last = runs[j] as { start: number; end: number }
        if (j === i) {
          const single = singleWordOwner(text, runs, i, node, foldedRun)
          if (single) consider(first.start, last.end, single.owner, j, single.ambiguous)
        } else if (node.owner !== undefined) consider(first.start, last.end, node.owner, j)
        for (const edge of node.edges ?? []) {
          const start = first.start - edge.lead.length
          const end = last.end + edge.trail.length
          if (start < cursor || start < from || end > to) continue
          if (edge.lead !== '' && start > 0 && wordCharBefore(text, start)) continue
          if (edge.trail !== '' && end < text.length && WORD_CHAR.test(codePointAt(text, end))) {
            continue
          }
          if (fold(text.slice(start, first.start)) !== edge.lead) continue
          if (fold(text.slice(last.end, end)) !== edge.trail) continue
          consider(start, end, edge.owner, j)
        }
        if (j + 1 >= runs.length || (!node.plain && !node.gaps)) break
        const gap = gapAfter(j)
        const level = gap === PLAIN_GAP ? node.plain : node.gaps?.get(gap)
        if (!level) break
        j += 1
        node = level.get(foldedRun(j))
      }
      const found = best as Found | null
      if (found) {
        out.push({
          start: found.start,
          end: found.end,
          owner: found.owner,
          ...(found.ambiguous ? { ambiguous: true as const } : {}),
        })
        cursor = found.end
        i = found.last
      }
    }
    return out
  }
}

/** The words of a line that make an identifier on it a credential. */
const CREDENTIAL_LABEL =
  /(?:tenant|chiave|key|secret|segreto|token|password|passcode|pwd|credenzial|credential|bearer)/iu
/** How far back on its line a label of a credential is looked for. */
const CREDENTIAL_LOOKBACK = 80

/** Whether the line before `start` (at most `CREDENTIAL_LOOKBACK` characters) names a credential. */
function credentialLine(text: string, start: number): boolean {
  const from = Math.max(0, start - CREDENTIAL_LOOKBACK)
  const before = text.slice(from, start)
  const line = before.slice(before.lastIndexOf('\n') + 1)
  return CREDENTIAL_LABEL.test(line)
}

/** A name found in a text: its place, its owner, and whether one word alone names several. */
export interface NameMatch {
  start: number
  end: number
  owner: number
  ambiguous?: true
}
type Found = NameMatch & { last: number }

/** Spaces, tabs and opening quotes or brackets skipped looking back for the start of a turn. */
const LEAD_IN = /[\p{Zs}\t"'«“‘([]/u
/** Most characters looked back over for the start of a turn or of a sentence. */
const MAX_LEAD_IN = 8
/** The gap after a greeting before a name: spaces and at most one comma. */
const GREETING_GAP = /^[\s,]{1,3}$/u

/**
 * Where a word stands: at the start of a turn of speech (the text, a line, or after «:», as in
 * «[00:01:02] Mario Rossi: andre, ci sei?») and at the start of a sentence (those, or after «.»,
 * «!», «?»). Looks back over at most `MAX_LEAD_IN` characters of spaces and quotes: constant work.
 */
function placeOf(text: string, start: number): { turn: boolean; sentence: boolean } {
  let at = start
  for (let k = 0; k < MAX_LEAD_IN && at > 0 && LEAD_IN.test(text[at - 1] as string); k += 1) {
    at -= 1
  }
  if (at === 0) return { turn: true, sentence: true }
  const c = text[at - 1] as string
  if (c === '\n' || c === '\r' || c === ':') return { turn: true, sentence: true }
  return { turn: false, sentence: c === '.' || c === '!' || c === '?' }
}

/**
 * The owner of one word alone of the dictionary (a first name, a surname, a short form), or null
 * when the text does not write it as a name:
 * - a word every case of which is the person (a member's part) matches in any case;
 * - a part of an outsider's name or a short form of a first name only with a capital or at the
 *   start of a turn;
 * - a word that is also a common word (`WORD_NAMES`, a short form that is a common word) only
 *   with a capital away from the start of a sentence, after a greeting («Ciao rosa»), or as a
 *   vocative at the start of a turn or sentence («Rosa, mi senti?»): «la rosa», «Will be done»
 *   stay.
 * One word that names people of different identities is ambiguous.
 */
function singleWordOwner(
  text: string,
  runs: readonly { start: number; end: number }[],
  i: number,
  node: Node,
  foldedRun: (i: number) => string,
): { owner: number; ambiguous: boolean } | null {
  const run = runs[i] as { start: number; end: number }
  const capital = CAPITAL.test(codePointAt(text, run.start))
  let place: { turn: boolean; sentence: boolean } | null = null
  const where = () => {
    place ??= placeOf(text, run.start)
    return place
  }
  let owner = node.owner
  if (owner === undefined) {
    if (node.capitalOwner === undefined || !(capital || where().turn)) return null
    owner = node.capitalOwner
  }
  if (node.guarded || WORD_NAMES.has(foldedRun(i))) {
    const before = runs[i - 1]
    const greeted =
      before !== undefined &&
      GREETINGS.has(foldedRun(i - 1)) &&
      GREETING_GAP.test(text.slice(before.end, run.start))
    const vocative = /^[,!?]/u.test(text.slice(run.end, run.end + 1)) && where().sentence
    if (!((capital && !where().sentence) || greeted || vocative)) return null
  }
  return { owner, ambiguous: node.ambiguous === true }
}

function codePointAt(text: string, at: number): string {
  return String.fromCodePoint(text.codePointAt(at) ?? 0)
}

/**
 * Where the word that holds the position `at` (a word character before it) starts, looking back
 * no further than `floor`: null when it starts before it. Bounded so that one long word is never
 * walked again for each number inside it.
 */
function startOfWord(text: string, at: number, floor: number): number | null {
  let start = at
  while (start > 0 && wordCharBefore(text, start)) {
    if (start <= floor) return null
    start -= unitsBefore(text, start)
  }
  return start
}

/** How many UTF-16 units the code point that ends just before `at` takes. */
function unitsBefore(text: string, at: number): number {
  const unit = text.charCodeAt(at - 1)
  return unit >= 0xdc00 && unit <= 0xdfff && at >= 2 ? 2 : 1
}

/** Where the rest of a number between `start` and `end` stops: after its last digit or bracket. */
function endOfTail(text: string, start: number, end: number): number {
  let at = end
  while (at > start && !PHONE_TAIL_END.test(text.slice(at - unitsBefore(text, at), at))) {
    at -= unitsBefore(text, at)
  }
  return at
}

/** Where the word that holds the position `at` ends. */
function endOfWord(text: string, at: number): number {
  const rest = /[\p{L}\p{N}\p{M}]*/uy
  rest.lastIndex = at
  rest.exec(text)
  return rest.lastIndex
}

/** Whether the code point that ends just before `at` is a word character. */
function wordCharBefore(text: string, at: number): boolean {
  return WORD_CHAR.test(codePointAt(text, at - unitsBefore(text, at)))
}

/** 1 -> A, 26 -> Z, 27 -> AA */
function letters(n: number): string {
  let out = ''
  let rest = n
  while (rest > 0) {
    rest -= 1
    out = String.fromCharCode(65 + (rest % 26)) + out
    rest = Math.floor(rest / 26)
  }
  return out
}

type Span = { start: number; end: number; credential?: true } & (
  | { kind: FixedKind }
  | { kind: 'person'; owner: number }
  | { kind: 'ambiguous' }
  | { kind: 'org'; owner: number | null }
)

/** A name of the gaps: of the dictionary, or an organization written with its legal form. */
type GapName = NameMatch | { start: number; end: number; owner: number; form: true }

/**
 * Replaces known people, emails and phone numbers with stable tokens and restores them.
 * It fails closed: when in doubt it tokenizes, it never leaves part of a matched span in clear.
 *
 * Input text and names are normalized to Unicode NFC first; `restore` therefore returns NFC
 * text, and `restore(pseudonymize(x)) === x` holds for NFC input.
 *
 * Emails, text shaped like a token, dates and times, and phone numbers are recognized first
 * (leftmost, in that order at one position): an email is one token even when it holds a name.
 * Names are looked for only in the text between them, with the dictionary of `PeopleMatcher`:
 * case-insensitive (simple case folding), never accent-insensitive; the words of a name match
 * joined by any run of spaces, dots, underscores, dashes or apostrophes.
 *
 * Token scheme (agent choice): each known person gets the number of its position in the
 * constructor list. The first distinct text matched for that person (any case, full name or
 * name part) becomes [PERSONA_n]; further distinct texts become [PERSONA_nA], [PERSONA_nB], ...
 * Emails and phones get [EMAIL_k] and [TELEFONO_k] per distinct text, numbered by first sight.
 * Text that already looks like a token gets [LITERAL_k]. Every distinct original text has its
 * own token, so the round trip is exact. Dates and times are left as they are.
 *
 * The mapping belongs to one instance; the dictionary can be shared (pass a `PeopleMatcher`).
 *
 * With `placeholders: 'index-free'` the same spans are hidden by the same recognizers, but every
 * person becomes [PERSONA], every email [EMAIL], every phone [TELEFONO] and every token-shaped
 * text [LITERAL], with no number: the text does not depend on the people list or its order (for
 * text stored as a vector). Nothing is kept, so such a text cannot be restored.
 */
/*
 * Since the pilot (STOP S4), also (agent choices, each with its guard against false positives):
 * - one word alone of a person known by two words: the first name and the surname as before, and
 *   the short forms of the first name (`firstNameVariants`) only with a capital or at the start of
 *   a turn; a word that is also common (`WORD_NAMES`) only as `singleWordOwner` allows;
 * - one word alone claimed by different people: [PERSONA_AMBIGUA_n], one number per word;
 * - organizations of the list ([ORG_n] per organization), written with a legal form, and domains
 *   written in the text ([ORG_n] per text);
 * - the links of meetings [LINK_RIUNIONE_n], their codes [CODICE_RIUNIONE_n] (the value, never
 *   the label) and GUIDs or long tokens [ID_n], before the phone numbers: a GUID is never a phone.
 *   The links and codes are credentials: `restore` keeps them hidden in a model's answer.
 */
export interface PseudonymizerOptions {
  /** `indexed` (the default): numbered, restorable tokens. */
  placeholders?: 'indexed' | 'index-free'
}

export class Pseudonymizer {
  // Holds real identities: private, observable only through pseudonymize and restore.
  private readonly map: PseudonymMap = { toPseudonym: new Map(), toReal: new Map() }
  private readonly variantCount = new Map<number, number>()
  private readonly counters = {
    EMAIL: 0,
    TELEFONO: 0,
    LITERAL: 0,
    LINK_RIUNIONE: 0,
    CODICE_RIUNIONE: 0,
    ID: 0,
  }
  private readonly keyCounters = { PERSONA_AMBIGUA: 0, ORG: 0 }
  private readonly keyed = new Map<string, { n: number; variants: number }>()
  /** The [ID_n] found on a line of a tenant, a key or a secret: withheld like a credential. */
  private readonly credentials = new Set<string>()
  private readonly matcher: PeopleMatcher
  private readonly indexFree: boolean

  constructor(people: readonly KnownPerson[] | PeopleMatcher, opts: PseudonymizerOptions = {}) {
    this.matcher = people instanceof PeopleMatcher ? people : new PeopleMatcher(people)
    this.indexFree = opts.placeholders === 'index-free'
  }

  pseudonymize(text: string): string {
    const t = text.normalize('NFC')
    const spans: Span[] = []
    const push = (found: readonly GapName[]) => {
      for (const name of found) {
        const { start, end, owner } = name
        if ('form' in name) spans.push({ start, end, kind: 'org', owner: null })
        else if (name.ambiguous) spans.push({ start, end, kind: 'ambiguous' })
        else if (this.matcher.isOrganization(owner)) spans.push({ start, end, kind: 'org', owner })
        else spans.push({ start, end, kind: 'person', owner })
      }
    }
    // The organizations written with their legal form (signatures, disclaimers), with the case
    // of the text: the next one at or after `orgFrom`, kept while the gaps move towards it, so
    // the text is searched once in all.
    const orgForm = new RegExp(ORGANIZATION_WITH_FORM.source, ORGANIZATION_WITH_FORM.flags)
    let orgFrom = -1
    let nextOrg: RegExpExecArray | null = null
    const orgAt = (from: number): RegExpExecArray | null => {
      if (orgFrom < 0 || from < orgFrom || (nextOrg !== null && nextOrg.index < from)) {
        orgForm.lastIndex = from
        nextOrg = orgForm.exec(t)
        orgFrom = from
      }
      return nextOrg
    }
    /** The names between `from` and `to`: organizations with a legal form, then the dictionary's. */
    const names = (from: number, to: number): GapName[] => {
      const out: GapName[] = []
      let at = from
      for (let m = orgAt(at); m !== null && m.index + m[0].length <= to; m = orgAt(at)) {
        for (const found of this.matcher.find(t, at, m.index)) out.push(found)
        out.push({ start: m.index, end: m.index + m[0].length, owner: 0, form: true })
        at = m.index + m[0].length
      }
      for (const found of this.matcher.find(t, at, to)) out.push(found)
      return out
    }
    const fixed = new RegExp(FIXED.source, FIXED.flags)
    const notPhone = new RegExp(NOT_PHONE_SOURCE, 'giu')
    // The first match of `notPhone` at or after `searchedFrom`; positions only grow, so the text
    // is searched once in all.
    let searchedFrom = -1
    let nextNotPhone: number | null = null
    const notPhoneFrom = (at: number): number | null => {
      if (searchedFrom < 0 || at < searchedFrom || (nextNotPhone !== null && nextNotPhone < at)) {
        notPhone.lastIndex = at
        nextNotPhone = notPhone.exec(t)?.index ?? null
        searchedFrom = at
      }
      return nextNotPhone
    }
    let gapStart = 0
    for (let m = fixed.exec(t); m !== null; m = fixed.exec(t)) {
      const start = m.index
      const end = start + m[0].length
      const group = FIXED_KINDS[m.slice(1).findIndex((g) => g !== undefined)]
      /* v8 ignore next -- unreachable: every alternative of FIXED is a group */
      if (group === undefined) throw new Error('pseudonymizer: match without a group')
      // A number or a date that starts inside a word ("mrossi79 3331234567", "Rossi12345678"):
      // a name that starts before it and runs into it, or ends right where it starts, wins, as
      // with one leftmost scan. Only a word that starts in the gap can hold such a name, so
      // each word is looked at once, however many numbers it holds.
      const wordStart =
        start > gapStart && wordCharBefore(t, start) ? startOfWord(t, start, gapStart) : null
      if (wordStart !== null) {
        const wordEnd = endOfWord(t, start)
        let found: GapName[] = names(gapStart, wordEnd)
        let over = found.find((n) => n.start < start && n.end > start)
        if (!over) {
          const glued = this.matcher.prefixAt(t, wordStart, start, Math.min(wordEnd, end))
          if (glued) {
            found = [...names(gapStart, wordStart), glued]
            if (glued.end > start) over = glued
            else {
              push(found)
              gapStart = glued.end
            }
          }
        }
        if (over) {
          push(found.filter((n) => n.end <= (over as { end: number }).end))
          gapStart = over.end
          fixed.lastIndex = over.end
          // The rest of the number stays hidden, however few digits it has left, up to an
          // email or a token-shaped text that starts inside it: those win over a number, as
          // anywhere else, and the scan resumes there. A real date or time right where the rest
          // starts wins too, as it would at that position in one scan.
          const tail =
            group === 'phone' && end > over.end ? /\p{Nd}|\(/u.exec(t.slice(over.end, end)) : null
          if (tail) {
            const tailStart = over.end + tail.index
            PROTECTED_AT.lastIndex = tailStart
            const other = PROTECTED_AT.test(t) ? tailStart : notPhoneFrom(tailStart)
            const cut = other !== null && other < end ? other : end
            const tailEnd = endOfTail(t, tailStart, cut)
            if (tailEnd > tailStart) {
              spans.push({ start: tailStart, end: tailEnd, kind: 'phone' })
              gapStart = tailEnd
              fixed.lastIndex = cut
            }
          }
          continue
        }
      }
      push(names(gapStart, start))
      // An identifier on a line that names a tenant, a key or a secret is a credential.
      if (group === 'id' && credentialLine(t, start)) {
        spans.push({ start, end, kind: group, credential: true })
      } else spans.push({ start, end, kind: group })
      gapStart = end
    }
    push(names(gapStart, t.length))
    let out = ''
    let at = 0
    for (const span of spans) {
      const match = t.slice(span.start, span.end)
      out += t.slice(at, span.start)
      at = span.end
      out += this.tokenOf(match, span)
    }
    return out + t.slice(at)
  }

  /**
   * The text with every token of this instance put back. Exact by default. With
   * `credentials: 'withheld'` (a model's answer) the links and codes of meetings stay as their
   * placeholders: a credential is never written back in clear, as no deliverable may hold one.
   */
  restore(text: string, opts: { credentials?: 'restored' | 'withheld' } = {}): string {
    if (this.indexFree) throw new Error('pseudonymizer: index-free text cannot be restored')
    const withheld = opts.credentials === 'withheld'
    return text.normalize('NFC').replace(TOKEN, (token) => {
      if (withheld && (CREDENTIAL_TOKEN.test(token) || this.credentials.has(token))) return token
      return this.map.toReal.get(token) ?? token
    })
  }

  private tokenOf(match: string, span: Span): string {
    if (span.kind === 'date') return match
    if (this.indexFree) return INDEX_FREE[span.kind]
    const known = this.map.toPseudonym.get(match)
    if (known !== undefined) return known
    switch (span.kind) {
      case 'person':
        return this.assign(match, this.personToken(span.owner))
      case 'ambiguous':
        return this.assign(match, this.keyedToken('PERSONA_AMBIGUA', fold(match)))
      case 'org':
      case 'domain':
        return this.assign(
          match,
          this.keyedToken(
            'ORG',
            span.kind === 'org' && span.owner !== null ? `owner:${span.owner}` : fold(match),
          ),
        )
      case 'email':
        return this.assign(match, this.nextCounted('EMAIL'))
      case 'literal':
        return this.assign(match, this.nextCounted('LITERAL'))
      case 'phone':
        return this.assign(match, this.nextCounted('TELEFONO'))
      case 'link':
        return this.assign(match, this.nextCounted('LINK_RIUNIONE'))
      case 'code':
        return this.assign(match, this.nextCounted('CODICE_RIUNIONE'))
      case 'id': {
        const token = this.assign(match, this.nextCounted('ID'))
        if (span.credential) this.credentials.add(token)
        return token
      }
    }
  }

  /**
   * A token numbered by a key, not by a position in the list: one number per ambiguous word or
   * per organization (its owner, or the folded text of one written with its legal form), and a
   * letter for each further way the text writes it ([ORG_1], [ORG_1A]).
   */
  private keyedToken(kind: 'PERSONA_AMBIGUA' | 'ORG', key: string): string {
    const full = `${kind}\u0000${key}`
    let entry = this.keyed.get(full)
    if (!entry) {
      this.keyCounters[kind] += 1
      entry = { n: this.keyCounters[kind], variants: 0 }
      this.keyed.set(full, entry)
    }
    const variant = entry.variants
    entry.variants += 1
    return `[${kind}_${entry.n}${variant === 0 ? '' : letters(variant)}]`
  }

  private assign(original: string, token: string): string {
    this.map.toPseudonym.set(original, token)
    this.map.toReal.set(token, original)
    return token
  }

  private nextCounted(
    kind: 'EMAIL' | 'TELEFONO' | 'LITERAL' | 'LINK_RIUNIONE' | 'CODICE_RIUNIONE' | 'ID',
  ): string {
    this.counters[kind] += 1
    return `[${kind}_${this.counters[kind]}]`
  }

  private personToken(owner: number): string {
    const seen = this.variantCount.get(owner) ?? 0
    this.variantCount.set(owner, seen + 1)
    return `[PERSONA_${owner}${seen === 0 ? '' : letters(seen)}]`
  }
}
