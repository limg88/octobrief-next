import { LANGS, vocabulary } from './language/index.ts'

// The organizations of a project hidden from the model like its people: the companies of the
// addresses its sources saw («@acme-logistica.it» → «Acme Logistica»), the names of the customer
// and of the projects its sources read, and those the PM adds. Pure: the caller reads them.

/** Longest name of an organization kept (a longer value is not a name). */
export const MAX_ORGANIZATION_NAME = 120
/**
 * Fewest letters of an organization found by the sources: a shorter acronym («DEM», «QA») is
 * hidden only when the PM adds it, since it is also a word of the text too often.
 */
export const MIN_AUTOMATIC_ORGANIZATION_LETTERS = 4

/**
 * Domains of public mail services and of the platforms every project writes about: the domain of
 * an address there says nothing of a company. «tim.it» and «tin.it» are not here: TIM can be a
 * customer or a supplier, and their names have three letters, so they become an organization only
 * when the PM adds them. «alice.it» stays: it is a consumer mail, and «Alice» is a first name.
 */
const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'yahoo',
  'icloud',
  'me',
  'mac',
  'libero',
  'virgilio',
  'tiscali',
  'alice',
  'fastweb',
  'fastwebnet',
  'email',
  'mail',
  'pec',
  'legalmail',
  'aruba',
  'arubapec',
  'protonmail',
  'proton',
  'gmx',
  'aol',
  'example',
  'localhost',
  'onmicrosoft',
  'microsoft',
  'sharepoint',
  'office365',
  'teams',
])

/** Platforms whose addresses name the company's tenant before them. */
const TENANT_PLATFORMS: ReadonlySet<string> = new Set(['onmicrosoft', 'sharepoint'])

/** Second levels that come before a country's domain («acme.co.uk», «ente.gov.it»). */
const SECOND_LEVELS: ReadonlySet<string> = new Set([
  'co',
  'com',
  'gov',
  'ac',
  'org',
  'net',
  'edu',
  'ltd',
  'plc',
])

/** The common words of every language, lower case: never an organization on their own. */
const COMMON: ReadonlySet<string> = new Set(
  LANGS.flatMap((lang) => {
    const v = vocabulary(lang)
    return [...v.COMMON_WORDS, ...v.NOT_PERSON_WORDS, ...v.NAME_PARTICLES]
  }),
)

const capitalized = (w: string) => (w === '' ? w : w.charAt(0).toUpperCase() + w.slice(1))

/**
 * The organization of a domain of an address, written as a name, or null: the label before the
 * domain of the country or of its second level («mail.acme-logistica.co.uk» → «Acme
 * Logistica»), never a public mail service, and only through `automaticOrganization`.
 */
export function organizationFromDomain(domain: string): string | null {
  const labels = domain
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\.$/u, '')
    .split('.')
    .filter((l) => l !== '')
  if (labels.length < 2) return null
  let at = labels.length - 2
  if (at > 0 && SECOND_LEVELS.has(labels[at] as string)) at -= 1
  // The tenant of a platform is the company («acme.onmicrosoft.com», «acme.sharepoint.com»).
  if (at > 0 && TENANT_PLATFORMS.has(labels[at] as string)) at -= 1
  const label = labels[at] as string
  if (PUBLIC_DOMAINS.has(label)) return null
  const name = label.split(/[-_]+/u).filter(Boolean).map(capitalized).join(' ')
  return automaticOrganization(name)
}

/** The domain of an email address, or null when it has none. */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  return email.slice(at + 1).replace(/[>\]\s].*$/u, '')
}

/**
 * The name of an organization a source gave, ready for the dictionary, or null when it should not
 * be hidden on its own: no letter, fewer than `MIN_AUTOMATIC_ORGANIZATION_LETTERS` letters, only
 * common words («Delivery», «Progetto Portale»), or longer than `MAX_ORGANIZATION_NAME`.
 */
export function automaticOrganization(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (name === '' || name.length > MAX_ORGANIZATION_NAME) return null
  const letters = name.replace(/[^\p{L}]/gu, '')
  if ([...letters].length < MIN_AUTOMATIC_ORGANIZATION_LETTERS) return null
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /\p{L}/u.test(w))
  if (words.length === 0 || words.every((w) => COMMON.has(w))) return null
  return name
}

/**
 * The name of an organization the PM adds: trimmed, one space between words, at least one
 * letter, at most `MAX_ORGANIZATION_NAME` characters. Short acronyms are allowed here: the PM
 * chose them. Null when it is not one.
 */
export function pmOrganization(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (name === '' || name.length > MAX_ORGANIZATION_NAME || !/\p{L}/u.test(name)) return null
  return name
}

/**
 * The legal forms of a company written after its name, as signatures and disclaimers write them
 * («Acme Logistica S.p.A.», «Contoso Ltd»): matched with the case of the text, after one to four
 * words that start with a capital.
 */
/**
 * Places that are a «spa» (wellness), never a company: «Centro Spa», «Hotel Spa», «Terme spa».
 */
const SPA_PLACES =
  '(?:[Cc]entro|CENTRO|[Hh]otel|HOTEL|[Rr]esort|[Tt]erme|[Ww]ellness|[Bb]eauty|[Dd]ay|[Bb]enessere|[Pp]iscina)'
const LEGAL_FORM = String.raw`(?:S\.\s?[Pp]\.\s?A\.?|s\.p\.a\.?|SpA|SPA|(?<!${SPA_PLACES}[ \t\u00a0,]{1,3})(?:Spa|spa)(?![ \t\u00a0]{1,3}(?:[Rr]esort|[Hh]otel|[Ww]ellness|[Bb]eauty|&))|S\.\s?[Rr]\.\s?[Ll]\.?(?:\s?[Ss]\.?)?|s\.r\.l\.?(?:s\.?)?|Srl|SRL|srl|Srls|srls|S\.\s?[Aa]\.\s?[Ss]\.?|s\.a\.s\.?|Sas|sas|SAS|S\.\s?[Nn]\.\s?[Cc]\.?|s\.n\.c\.?|Snc|snc|SNC|Ltd\.?|Limited|Inc\.?|LLC|GmbH|AG|PLC|Plc|Corp\.?|Corporation|B\.V\.|N\.V\.|S\.A\.)`
const ORG_WORD = String.raw`\p{Lu}[\p{L}\p{M}\p{N}&'’-]{0,40}`
/**
 * An organization written with its legal form, case-sensitive and linear: one to four words with
 * a capital, then the form, then no letter or digit.
 */
export const ORGANIZATION_WITH_FORM = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}])${ORG_WORD}(?:[ \t ]{1,3}(?:&[ \t ]{1,3})?${ORG_WORD}){0,3}[ \t ,]{1,3}${LEGAL_FORM}(?![\p{L}\p{N}\p{M}])`,
  'gu',
)
