import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { firstNameVariants, Pseudonymizer } from '../src/index.ts'
import { growthSlope, HANG_GUARD_MS, MAX_GROWTH_SLOPE } from './timing.ts'

// Property-based tests of the pseudonymizer. Everything is synthetic: names, addresses
// and numbers are generated from syllables and digits, never real data. The seed is fixed so a
// run is reproducible; a counterexample found with another seed becomes a fixed test in
// pseudonymizer.test.ts and is fixed in core.
const SEED = 20261105
const RUNS = 100
// Each run builds a pseudonymizer (its pattern is compiled on first use, a few ms), so the
// number of runs is kept modest; the generators cover the space, not the count. The explicit
// timeout leaves room for a slow CI runner.
const TIMEOUT = 20_000
const options = { seed: SEED, numRuns: RUNS } as const

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

// --- generators ---------------------------------------------------------------------------

const SYLLABLES = [
  'ma',
  'ri',
  'o',
  'ros',
  'si',
  'ber',
  'ga',
  'mi',
  'lu',
  'ca',
  'to',
  'ne',
  'fran',
  'ces',
  'co',
  'pao',
  'la',
  'gi',
  'an',
  'ni',
  'dr',
  'ea',
  'ele',
  'na',
  'zu',
  'pe',
  'trò',
  'pè',
  'cò',
  'bù',
  'ghì',
  'lì',
  'sà',
  'ré',
  'çe',
  'ñu',
  'öl',
  'ß',
]

const namePart = fc
  .array(fc.constantFrom(...SYLLABLES), { minLength: 2, maxLength: 4 })
  .map((s) => s.join(''))
  .filter((s) => s.length >= 4)

/** A given name or surname, possibly Italian-styled: capitalised, D'/dell' prefix, double with hyphen. */
const nameWord = fc
  .tuple(namePart, namePart, fc.constantFrom('plain', 'apostrophe', 'curly', 'hyphen', 'upper'))
  .map(([a, b, style]) => {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    switch (style) {
      case 'apostrophe':
        return `D'${cap(a)}`
      case 'curly':
        return `Dell’${cap(a)}`
      case 'hyphen':
        return `${cap(a)}-${cap(b)}`
      case 'upper':
        return a.toUpperCase()
      default:
        return cap(a)
    }
  })

const displayName = fc
  .array(nameWord, { minLength: 2, maxLength: 3 })
  .map((words) => words.join(' '))

const digits = (min: number, max: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max })
    .map((d) => d.join(''))

// Spaces of every width, tab, hyphens and dashes, and invisible separators (soft hyphen,
// zero-width space) all appear between the digits of a real phone number.
const PHONE_SEPARATORS = [
  ' ',
  ' ',
  ' ',
  ' ',
  '.',
  '-',
  '/',
  '\u00a0',
  '\u202f',
  '\u2009',
  '\u2010',
  '\u2013',
  '\u2014',
  '\t',
  '\u2002',
  '\u2003',
  '\u200a',
  '\u3000',
  '\u00ad',
  '\u200b',
]

/** The same number written with other decimal digits: fullwidth or Arabic-Indic. */
const DIGIT_SCRIPTS = [0x30, 0xff10, 0x660] as const

const phone = fc
  .tuple(
    fc.constantFrom('', '+39 ', '+39', '0039 ', '+44 ', '+1 ', '+49', '0'),
    fc.array(digits(2, 4), { minLength: 3, maxLength: 5 }),
    fc.constantFrom(...PHONE_SEPARATORS),
    fc.constantFrom('', '(0)'),
    fc.constantFrom(...DIGIT_SCRIPTS),
  )
  .map(([prefix, groups, sep, zero, base]) =>
    `${prefix}${zero}${groups.join(sep)}`.replace(/[0-9]/g, (d) =>
      String.fromCodePoint(base + Number(d)),
    ),
  )
  .filter((p) => (p.match(/\p{Nd}/gu) ?? []).length >= 8)

const label = fc
  .array(fc.constantFrom(...'abcdefghilmnoprstuvz0123456789'.split('')), {
    minLength: 1,
    maxLength: 8,
  })
  .map((c) => c.join(''))

const email = fc
  .tuple(
    fc.array(label, { minLength: 1, maxLength: 3 }),
    fc.constantFrom('.', '_', '-', '+', '.', ','),
    fc.array(label, { minLength: 1, maxLength: 3 }),
    fc.constantFrom('it', 'com', 'example', 'org', 'eu'),
    fc.boolean(),
  )
  .map(([local, sep, domain, tld, upper]) => {
    const address = `${local.join(sep)}@${domain.join('.')}.${tld}`
    return upper ? address.toUpperCase() : address
  })

const FILLER = [
  'riunione',
  'stato',
  'budget',
  'il',
  'del',
  'progetto',
  'consegna',
  'rinviata',
  'contatto',
  'scrivere',
  'chiamare',
  'tel',
  'email',
  'cliente',
  'verbale',
]
const filler = fc
  .array(fc.constantFrom(...FILLER), { minLength: 0, maxLength: 6 })
  .map((w) => w.join(' '))
const glue = fc.constantFrom(' ', ': ', ', ', '\n', ' - ', ' (', ') ', '; ')

interface Doc {
  text: string
  names: string[]
  emails: string[]
  phones: string[]
}

/** Random text with a mix of names, emails and phones embedded between plain filler. */
const document: fc.Arbitrary<Doc> = fc
  .tuple(
    fc.array(displayName, { minLength: 1, maxLength: 3 }),
    fc.array(email, { minLength: 0, maxLength: 3 }),
    fc.array(phone, { minLength: 0, maxLength: 3 }),
  )
  .chain(([names, emails, phones]) => {
    const items = [
      ...names.map((value) => ({ kind: 'name' as const, value })),
      ...emails.map((value) => ({ kind: 'email' as const, value })),
      ...phones.map((value) => ({ kind: 'phone' as const, value })),
    ]
    return fc
      .tuple(
        fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }),
        fc.array(fc.tuple(filler, glue), {
          minLength: items.length + 1,
          maxLength: items.length + 1,
        }),
      )
      .map(([order, between]) => {
        let text = ''
        order.forEach((item, i) => {
          const [words, sep] = between[i] as [string, string]
          const closer = sep === ' (' ? ')' : ''
          text += `${words}${sep}${item.value}${closer} `
        })
        text += (between[items.length] as [string, string])[0]
        return { text, names, emails, phones }
      })
  })

// --- helpers ------------------------------------------------------------------------------

const norm = (s: string) => s.normalize('NFC').toLowerCase()

/** Whether `needle` appears in `haystack` as a whole word (word characters on neither side). */
function appearsAsWord(haystack: string, needle: string): boolean {
  const h = norm(haystack)
  const n = norm(needle)
  for (let at = h.indexOf(n); at !== -1; at = h.indexOf(n, at + 1)) {
    const before = h.slice(0, at).at(-1)
    const after = h.at(at + n.length)
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true
  }
  return false
}

const TOKENS =
  /\[(?:PERSONA_AMBIGUA|PERSONA|EMAIL|TELEFONO|LITERAL|ORG|LINK_RIUNIONE|CODICE_RIUNIONE|ID)_\d+[A-Z]*\]/g
const digitsOf = (s: string) => s.replace(/[^\p{Nd}]/gu, '')

function timeOf(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

// --- properties ---------------------------------------------------------------------------

describe('pseudonymizer properties', () => {
  it(
    'leaves no generated name, email or phone number in the output',
    () => {
      fc.assert(
        fc.property(document, (doc) => {
          const out = new Pseudonymizer(
            doc.names.map((displayName) => ({ displayName })),
          ).pseudonymize(doc.text)
          const bare = out.replace(TOKENS, '')
          for (const name of doc.names) {
            expect(norm(out)).not.toContain(norm(name))
            for (const word of name.split(/[\s._'’-]+/).filter((w) => w.length >= 3)) {
              expect(appearsAsWord(out, word), `${word} left in clear`).toBe(false)
            }
          }
          for (const address of doc.emails) expect(norm(out)).not.toContain(norm(address))
          // No address survives in part either: the text has no "@" of its own.
          expect(bare).not.toContain('@')
          // No run of digits from a phone number survives; the filler has no digits.
          expect(digitsOf(bare)).toBe('')
        }),
        options,
      )
    },
    TIMEOUT,
  )

  it(
    'leaves no name in clear in any case or Unicode form',
    () => {
      fc.assert(
        fc.property(
          displayName,
          fc.constantFrom('upper', 'lower', 'nfd', 'as-is'),
          filler,
          (name, form, words) => {
            const shown =
              form === 'upper'
                ? name.toUpperCase()
                : form === 'lower'
                  ? name.toLowerCase()
                  : form === 'nfd'
                    ? name.normalize('NFD')
                    : name
            const out = new Pseudonymizer([{ displayName: name }]).pseudonymize(
              `${words} ${shown} ${words}`,
            )
            expect(norm(out)).not.toContain(norm(name))
            expect(out).toMatch(/\[PERSONA_1[A-Z]*\]/)
          },
        ),
        options,
      )
    },
    TIMEOUT,
  )

  it(
    'restore(pseudonymize(x)) is the NFC form of x, for text with and without PII',
    () => {
      const wild = fc.oneof(
        fc.string({ unit: 'grapheme', maxLength: 30 }),
        fc.string({ unit: 'binary', maxLength: 30 }),
        fc.constantFrom('[PERSONA_1]', '[EMAIL_2]', '[TELEFONO_1]', '[LITERAL_1]', '[PERSONA_1A]'),
        fc.constantFrom('é', 'ö', 'Å', 'ñ', 'ñ'),
      )
      fc.assert(
        fc.property(
          document,
          fc.array(wild, { maxLength: 6 }),
          fc.boolean(),
          (doc, extras, decompose) => {
            const raw = `${extras.join(' ')} ${doc.text} ${extras.join('')}`
            const text = decompose ? raw.normalize('NFD') : raw
            const p = new Pseudonymizer(doc.names.map((displayName) => ({ displayName })))
            expect(p.restore(p.pseudonymize(text))).toBe(text.normalize('NFC'))
          },
        ),
        options,
      )
    },
    TIMEOUT,
  )

  it(
    'restores a second text with the same tokens (stable mapping across calls)',
    () => {
      fc.assert(
        fc.property(document, (doc) => {
          const p = new Pseudonymizer(doc.names.map((displayName) => ({ displayName })))
          const first = p.pseudonymize(doc.text)
          const second = p.pseudonymize(doc.text)
          expect(second).toBe(first)
          expect(p.restore(first)).toBe(doc.text.normalize('NFC'))
        }),
        options,
      )
    },
    TIMEOUT,
  )

  // The leaks of the pilot as properties: a first name alone and a pet name of it, a meeting
  // link with its tenant and organizer, a passcode, a GUID, an organization of the list and one
  // written with its legal form. None is left in clear, and restore is exact.
  const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const hexDigits = (min: number, max: number) =>
    fc
      .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: min, maxLength: max })
      .map((d) => d.join(''))
  const guid = fc
    .tuple(hexDigits(8, 8), hexDigits(4, 4), hexDigits(4, 4), hexDigits(4, 4), hexDigits(12, 12))
    .map((parts) => parts.join('-'))
  const pilotCase = fc.record({
    first: fc.constantFrom('giuseppe', 'francesco', 'alessandro', 'roberto', 'massimo', 'vincenzo'),
    last: namePart,
    org: fc.tuple(namePart, namePart).map(([a, b]) => `${capital(a)} ${capital(b)}`),
    company: namePart.map((a) => capital(a)),
    tenant: guid,
    organizer: guid,
    passcode: fc.tuple(label, digits(1, 3)).map(([a, d]) => `${a}${d}`),
    filler,
  })

  it(
    'leaves no first name alone, meeting link, code, guid or organization in clear',
    () => {
      fc.assert(
        fc.property(pilotCase, (c) => {
          const name = `${capital(c.first)} ${capital(c.last)}`
          const short = capital(firstNameVariants(c.first)[0] as string)
          const link =
            'https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0' +
            `?context=%7b%22Tid%22%3a%22${c.tenant}%22%2c%22Oid%22%3a%22${c.organizer}%22%7d`
          const text =
            `${c.filler} ne parla ${capital(c.first)} con ${short}, poi ${capital(c.last)}.\n` +
            `Partecipa <${link}>\nPasscode: ${c.passcode}\nID ${c.tenant}\n` +
            `${c.org} conferma. ${c.company} S.r.l. firma. ${c.filler}`
          const p = new Pseudonymizer([
            { displayName: name },
            { displayName: c.org, kind: 'organization' },
          ])
          const out = p.pseudonymize(text)
          for (const word of [c.first, short, c.last, c.company]) {
            expect(appearsAsWord(out, word), `${word} left in clear`).toBe(false)
          }
          expect(norm(out)).not.toContain(norm(c.org))
          for (const secret of [c.tenant, c.organizer, 'meetup-join', c.passcode]) {
            expect(out).not.toContain(secret)
          }
          expect(out).not.toContain('TELEFONO')
          expect(p.restore(out)).toBe(text.normalize('NFC'))
        }),
        options,
      )
    },
    TIMEOUT,
  )

  describe('running time', () => {
    const people = [{ displayName: "Maria D'Angelo" }, { displayName: 'Mario Rossi' }]
    const units: [string, string][] = [
      ['digit groups', '12 34 56 78 '],
      ['dots and digits', '1.2.3.4.'],
      ['near-phone prefix', '+39 '],
      ['bracketed zeros', '(0)(0)'],
      ['many ats', 'a@'],
      ['commas', 'a,'],
      ['quoted after comma', 'a@b.it,"a b"@'],
      ['comma local parts', 'a,b,c '],
      ['dotted words', 'ab.cd.'],
      ['long local part', 'abcdefgh.'],
      ['quotes', '"a@'],
      ['names', 'Mario Rossi, '],
      ['name parts', 'Maria D'],
      ['separators', ' - . / '],
      ['dates', '12.04.2026 10:30 '],
      ['meeting links', 'https://teams.microsoft.com/l/meetup-join/a?context=b '],
      ['link schemes', 'https://www.'],
      ['meeting codes', 'PIN: 1 ID riunione 2 '],
      ['hex with dashes', 'ab12-'],
      ['legal forms', 'Acme Quarzo S.p.A. '],
      ['domains', 'a.it b.com '],
      ['first names', 'Ciao Maria, Mari e Mario. '],
    ]

    it.each(units)(
      'grows linearly on %s repeated',
      (_label, unit) => {
        // 2 000 to 16 000 repetitions: a linear matcher fits a log-log slope of about 1, a
        // quadratic one about 2. Short calls are repeated within a sample, so the small sizes
        // are measured, not lost in timer noise. Only the slope is asserted, so slow or
        // instrumented runners do not matter; the absolute ceiling is a hang guard.
        const { slope, largeMs } = growthSlope((fraction) => {
          const text = unit.repeat(Math.round(16_000 * fraction))
          return () => new Pseudonymizer(people).pseudonymize(text)
        })
        expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs).toBeLessThan(HANG_GUARD_MS)
      },
      TIMEOUT,
    )

    it(
      'stays bounded on generated hostile input of 200 KB',
      () => {
        fc.assert(
          fc.property(
            fc.array(fc.constantFrom(...'0123456789 .-/@+()_,;" \n'.split('')), {
              minLength: 20,
              maxLength: 40,
            }),
            (alphabet) => {
              const unit = alphabet.join('')
              const text = unit.repeat(Math.ceil(200_000 / unit.length))
              const elapsed = timeOf(() => new Pseudonymizer(people).pseudonymize(text))
              expect(elapsed).toBeLessThan(HANG_GUARD_MS)
            },
          ),
          { seed: SEED, numRuns: 25 },
        )
      },
      TIMEOUT,
    )
  })
})
