import { describe, expect, it } from 'vitest'
import { MAX_DICTIONARY_PEOPLE, PeopleMatcher, Pseudonymizer } from '../src/recipe/index.ts'
import { growthSlope, HANG_GUARD_MS, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

const people = [{ displayName: 'Mario Rossi', email: 'mario.rossi@example.com' }]

describe('pseudonymizer', () => {
  it('pseudonymizer replaces names, emails and phones and restores them', () => {
    const p = new Pseudonymizer(people)
    const text = 'Mario Rossi (mario.rossi@example.com, +39 333 1234567) parla con Rossi'
    const out = p.pseudonymize(text)
    expect(out).not.toContain('Mario')
    expect(out).not.toContain('Rossi')
    expect(out).not.toContain('@example.com')
    expect(out).not.toContain('333')
    expect(out).toContain('[PERSONA_1]')
    expect(out).toContain('[EMAIL_1]')
    expect(out).toContain('[TELEFONO_1]')
    expect(p.restore(out)).toBe(text)
  })

  it('pseudonymizer gives stable tokens within one instance', () => {
    const p = new Pseudonymizer(people)
    const a = p.pseudonymize('Mario Rossi chiama 333 1234567')
    const b = p.pseudonymize('di nuovo Mario Rossi, 333 1234567; poi 02 12345678')
    expect(a).toBe('[PERSONA_1] chiama [TELEFONO_1]')
    expect(b).toBe('di nuovo [PERSONA_1], [TELEFONO_1]; poi [TELEFONO_2]')
  })

  it('pseudonymizer keeps round trip for case variants and name parts', () => {
    const p = new Pseudonymizer([...people, { displayName: 'Anna Verdi' }])
    const text = 'MARIO ROSSI, mario rossi, Rossi, rossi e anna verdi con Anna'
    const out = p.pseudonymize(text)
    expect(out).not.toMatch(/rossi|anna|verdi/i)
    expect(out).toContain('[PERSONA_2')
    expect(p.restore(out)).toBe(text)
  })

  it('pseudonymizer does not touch substrings of other words', () => {
    const p = new Pseudonymizer([{ displayName: 'Ugo' }])
    expect(p.pseudonymize('Ugolini incontra Ugo')).toBe('Ugolini incontra [PERSONA_1]')
  })

  it('pseudonymizer treats accented letters as word characters', () => {
    const p = new Pseudonymizer([{ displayName: 'Ugo Bianchi' }])
    expect(p.pseudonymize('Ugòlo e Ugo')).toBe('Ugòlo e [PERSONA_1]')
  })

  it('pseudonymizer leaves years, short ids, dates and times untouched', () => {
    const p = new Pseudonymizer([])
    const text = 'US 27965 del 2026-11-04 alle 10:30, anno 2026, rif. 04.11.2026'
    expect(p.pseudonymize(text)).toBe(text)
  })

  it('pseudonymizer detects italian and international phone formats', () => {
    const p = new Pseudonymizer([])
    for (const phone of ['+39 333 1234567', '333 1234567', '02 12345678', '0039 02 12345678']) {
      const out = p.pseudonymize(`tel ${phone}.`)
      expect(out).toMatch(/^tel \[TELEFONO_\d\]\.$/)
      expect(p.restore(out)).toBe(`tel ${phone}.`)
    }
  })

  it('pseudonymizer replaces emails whole even when they contain a known name', () => {
    const p = new Pseudonymizer(people)
    const out = p.pseudonymize('scrivi a mario.rossi@example.com o altro@example.org.')
    expect(out).toBe('scrivi a [EMAIL_1] o [EMAIL_2].')
    expect(p.restore(out)).toBe('scrivi a mario.rossi@example.com o altro@example.org.')
  })

  it('pseudonymizer prefers the longest name and ignores short name parts', () => {
    const p = new Pseudonymizer([{ displayName: 'Li Xu' }, { displayName: 'Li Xu Wang' }])
    const out = p.pseudonymize('Li Xu Wang e Li Xu')
    expect(out).not.toContain('Wang')
    expect(p.restore(out)).toBe('Li Xu Wang e Li Xu')
    expect(p.pseudonymize('Xu')).toBe('Xu')
  })

  it('pseudonymizer restore leaves unknown tokens and plain text alone', () => {
    const p = new Pseudonymizer(people)
    expect(p.restore('niente [PERSONA_9] qui')).toBe('niente [PERSONA_9] qui')
    expect(p.pseudonymize('nulla da fare')).toBe('nulla da fare')
  })

  it('pseudonymizer ignores blank people and keeps its mapping private', () => {
    const p = new Pseudonymizer([{ displayName: '   ' }])
    expect(p.pseudonymize('ciao')).toBe('ciao')
    expect(p.pseudonymize('333 1234567')).toBe('[TELEFONO_1]')
    expect(p.restore('[TELEFONO_1]')).toBe('333 1234567')
    // @ts-expect-error the mapping holds real identities and is not part of the public API
    void p.map
  })

  it('pseudonymizer escapes regex characters in names', () => {
    const p = new Pseudonymizer([{ displayName: 'J. (Jo) Smith+' }])
    expect(p.pseudonymize('Smith+ ok')).toContain('[PERSONA_1')
  })
})

describe('pseudonymizer edge cases for phones, dates, emails and names', () => {
  it('pseudonymizer detects phones with dash, slash, dot and bracket separators', () => {
    const p = new Pseudonymizer([])
    for (const phone of [
      '333-1234567',
      '02/12345678',
      '333.123.4567',
      '+39-333-1234567',
      '+39 (02) 1234567',
      '+39 (0)2 12345678',
      '(02) 12345678',
    ]) {
      const out = p.pseudonymize(`tel ${phone}.`)
      expect(out).toMatch(/^tel \[TELEFONO_\d\]\.$/)
      expect(p.restore(out)).toBe(`tel ${phone}.`)
    }
  })

  it('pseudonymizer keeps dates, times and short numbers while still finding a phone next to them', () => {
    const p = new Pseudonymizer([])
    for (const text of [
      'il 2026-11-04',
      'il 04/11/2026',
      'il 04.11.2026',
      'il 04-11-2026',
      'il 4/11/2026',
      'alle 12:30',
      '2026-11-04T10:30:00',
      'US 27965',
    ]) {
      expect(p.pseudonymize(text)).toBe(text)
    }
    expect(p.pseudonymize('2026-11-04 333 1234567')).toBe('2026-11-04 [TELEFONO_1]')
  })

  it('pseudonymizer replaces names written as handles with underscore, dot or dash', () => {
    const p = new Pseudonymizer(people)
    const text = 'mario_rossi, mario.rossi, mario-rossi, Mario  Rossi, @mario_rossi'
    const out = p.pseudonymize(text)
    expect(out).not.toMatch(/mario|rossi/i)
    expect(p.restore(out)).toBe(text)
  })

  it('pseudonymizer normalizes to NFC so decomposed names do not leak', () => {
    const p = new Pseudonymizer([{ displayName: 'José Álvarez' }])
    const nfc = 'José Álvarez e Álvarez'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    const out = p.pseudonymize(nfd)
    expect(out).not.toMatch(/Jos|lvarez/)
    expect(p.restore(out)).toBe(nfc)
    expect(p.restore(p.pseudonymize(nfc))).toBe(nfc)
  })

  it('pseudonymizer name parts split on dash and apostrophe', () => {
    const p = new Pseudonymizer([{ displayName: "Anna-Maria D'Angelo" }])
    const text = "Anna e Maria e Angelo e Anna-Maria D'Angelo e D’Angelo"
    const out = p.pseudonymize(text)
    expect(out).not.toMatch(/anna|maria|angelo/i)
    expect(p.restore(out)).toBe(text)
  })

  it('pseudonymizer round trips text that already looks like a token', () => {
    const p = new Pseudonymizer(people)
    const text = 'vedi [PERSONA_1] e [EMAIL_1] con Mario Rossi e [LITERAL_1]'
    const out = p.pseudonymize(text)
    expect(p.restore(out)).toBe(text)
    expect(out).toContain('[PERSONA_1]')
    expect(out.match(/\[PERSONA_1\]/g)).toHaveLength(1)
  })

  it('pseudonymizer never emits an undefined owner for case-fold mismatches', () => {
    const p = new Pseudonymizer([{ displayName: 'Οδυσσεύς' }])
    const text = 'ο Οδυσσεύσ parla'
    const out = p.pseudonymize(text)
    expect(out).not.toContain('undefined')
    expect(out).toContain('[PERSONA_1')
    expect(p.restore(out)).toBe(text)
  })

  it('pseudonymizer fails closed on long digit sequences', () => {
    const p = new Pseudonymizer([])
    for (const text of [
      'rif (1234)(1234)(1234)(1234) 12345678 fine',
      'tel 333 123 456 789 0123 ok',
      'id 12345678901234567890 e 3331234567 ok',
      'tel333 1234567',
      'ora 10:333 1234567',
    ]) {
      const out = p.pseudonymize(text)
      expect(out).not.toMatch(/\d{3}/)
      expect(p.restore(out)).toBe(text)
    }
  })

  it('pseudonymizer tokenizes phones whose tail looks like a date but is not one', () => {
    const p = new Pseudonymizer([])
    for (const text of [
      'tel +39 333 1234.56.78',
      'tel 06 12.34.5678',
      'tel +39 02 12/34/5678',
      'tel 06 12 13.14.1234',
    ]) {
      const out = p.pseudonymize(text)
      expect(out.replace(/\[[A-Z]+_\d+\]/g, '')).not.toMatch(/\d/)
      expect(p.restore(out)).toBe(text)
    }
  })

  it('pseudonymizer absorbs unusual local parts and repeated at signs into one token', () => {
    const p = new Pseudonymizer([])
    for (const email of [
      "o'brien@x.com",
      '"a b"@x.com',
      '"mario rossi"@example.com',
      'a(b)@x.com',
      'a@b@c.com',
      'a@b.com@c.com',
      'mario@[10.0.0.1 ]',
      'x"y@z.org',
    ]) {
      const out = p.pseudonymize(`scrivi a ${email}, ok`)
      expect(out).toMatch(/^scrivi a \[EMAIL_\d+\], ok$/)
      expect(p.restore(out)).toBe(`scrivi a ${email}, ok`)
    }
    const wrapped = p.pseudonymize('(mario.rossi@example.com) e <a(b)@x.com>')
    expect(wrapped).not.toMatch(/mario|example|x\.com/)
  })

  it('pseudonymizer tokenizes odd emails glued to colons and braces in plain text', () => {
    const p = new Pseudonymizer([])
    for (const text of [
      'to:a(b)@x.com',
      '{a(b)@x.com}',
      'x{a(b)@x.com',
      'mailto:a@b@c.com',
      "mail:o'brien@x.com",
      'mario@local:host',
    ]) {
      const out = p.pseudonymize(text)
      expect(out).toMatch(/\[EMAIL_\d+\]/)
      expect(out).not.toMatch(/x\.com|c\.com|host|brien/)
      expect(p.restore(out)).toBe(text)
    }
  })

  it('pseudonymizer registers name parts without surrounding quotes or brackets', () => {
    const p = new Pseudonymizer([{ displayName: 'Anna "Nana" Bianchi' }])
    const out = p.pseudonymize('Ha scritto Nana ieri, anche (Bianchi) e «Anna»')
    expect(out).not.toMatch(/Nana|Bianchi|Anna/)
    expect(p.restore(out)).toBe('Ha scritto Nana ieri, anche (Bianchi) e «Anna»')
  })

  it('pseudonymizer strips any non-letter edge punctuation from name parts', () => {
    for (const nick of ['“Nana”', '<Nana>', '{Nana}', '‹Nana›']) {
      const p = new Pseudonymizer([{ displayName: `Anna ${nick} Bianchi` }])
      const out = p.pseudonymize('ha scritto Nana ieri')
      expect(out).not.toContain('Nana')
      expect(p.restore(out)).toBe('ha scritto Nana ieri')
    }
  })

  it('pseudonymizer accepts unicode hyphens, minus and exotic spaces in phones', () => {
    const p = new Pseudonymizer([])
    for (const phone of [
      '333‐1234567',
      '333‑1234567',
      '333−1234567',
      '333 1234567',
      '+39 333 1234567',
      '333 123 4567',
    ]) {
      const out = p.pseudonymize(`tel ${phone}.`)
      expect(out).toMatch(/^tel \[TELEFONO_\d\]\.$/)
      expect(p.restore(out)).toBe(`tel ${phone}.`)
    }
  })

  it('pseudonymizer keeps dotted times after ore, alle, dalle or h', () => {
    const p = new Pseudonymizer([])
    for (const text of ['ore 10.30 - 11.30 del 04/11/2026', 'dalle 9.00 alle 10.30', 'h 23.59']) {
      expect(p.pseudonymize(text)).toBe(text)
    }
    expect(p.pseudonymize('tel 10.30 - 11.30')).toBe('tel [TELEFONO_1]')
  })

  it('pseudonymizer tokenizes emails beyond the strict bounds as a whole', () => {
    const p = new Pseudonymizer([])
    const cases = [
      `${'a'.repeat(65)}@example.com`,
      `${'b'.repeat(200)}@example.com`,
      'user@a.b.c.d.e.f.g.h.i.j.k.l.example.com',
      'user@a.b.c.d.e.f.g.h.iii.jjj.com',
      `user@example.${'z'.repeat(30)}`,
      'mario@localhost',
      'user@[192.168.1.1]',
    ]
    for (const email of cases) {
      const out = p.pseudonymize(`scrivi a ${email}, ok`)
      expect(out).toMatch(/^scrivi a \[EMAIL_\d+\], ok$/)
      expect(p.restore(out)).toBe(`scrivi a ${email}, ok`)
    }
    expect(p.pseudonymize('scrivi a mario@localhost.')).toMatch(/\[EMAIL_\d+\]\.$/)
  })

  it('pseudonymizer keeps dates and times that follow a number', () => {
    const p = new Pseudonymizer([])
    for (const text of [
      '10:30 04.11.2026',
      'pag. 12 04.11.2026',
      'n. 1234 2026-11-04',
      '3 04/11/2026',
      'tra 20 e 30 04.11.2026',
      '10:30:15 04-11-2026',
      '2026-11-04T10:30:00',
    ]) {
      expect(p.pseudonymize(text)).toBe(text)
    }
    expect(p.pseudonymize('10:30 333 1234567 il 04.11.2026')).toBe(
      '10:30 [TELEFONO_1] il 04.11.2026',
    )
  })

  it('pseudonymizer accepts en dash, em dash and spaced separators in phones', () => {
    const p = new Pseudonymizer([])
    for (const phone of ['333 - 123 - 4567', '333–1234567', '333—1234567', '+39 – 333 – 1234567']) {
      const out = p.pseudonymize(`tel ${phone}.`)
      expect(out).toMatch(/^tel \[TELEFONO_\d\]\.$/)
      expect(p.restore(out)).toBe(`tel ${phone}.`)
    }
  })

  it(
    'pseudonymizer handles 1 MB hostile inputs in linear time',
    () => {
      const p = new Pseudonymizer(people)
      const mb = 1024 * 1024
      const inputs = [
        'a'.repeat(mb),
        'a.'.repeat(mb / 2),
        'a.a.a.@'.repeat(mb / 7),
        '1'.repeat(mb),
        '1 '.repeat(mb / 2),
        '1-'.repeat(mb / 2),
        `Mario${' '.repeat(mb)}`,
        'Mario '.repeat(mb / 6),
        `${'a'.repeat(60)}@${'b.'.repeat(mb / 4)}`,
        '('.repeat(mb),
        'x@'.repeat(mb / 2),
        '@'.repeat(mb),
        `a@${'.'.repeat(mb)}`,
        `${'a'.repeat(mb)}@a`,
        '1 1 1 1 1 1 1 x '.repeat(mb / 16),
        '1 04.11.2026 '.repeat(mb / 13),
        '10:30 '.repeat(mb / 6),
        'a,'.repeat(mb / 2),
        'a('.repeat(mb / 2),
        "a'".repeat(mb / 2),
        '"'.repeat(mb),
        `"${'a '.repeat(mb / 2)}`,
        `a@${'x,'.repeat(mb / 2)}`,
        '1.2.3 '.repeat(mb / 6),
        'ore 1.30 '.repeat(mb / 9),
      ]
      for (const input of inputs) {
        const { slope, largeMs } = growthSlope((fraction) => {
          const part = input.slice(0, Math.round(input.length * fraction))
          return () => p.pseudonymize(part)
        })
        expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs).toBeLessThan(HANG_GUARD_MS)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})

describe('pseudonymizer phone numbers written with unusual spaces or digits', () => {
  // Counterexamples found by the property tests, kept as fixed cases. The characters are
  // built from code points because most of them are invisible.
  const c = (...codes: number[]) => String.fromCodePoint(...codes)
  const digitsIn = (base: number) => c(...[0, 3, 3, 3, 1, 2, 3, 4, 5, 6, 7].map((d) => base + d))
  const cases: [string, string][] = [
    ['zero-width space between groups', `(0)00${c(0x200b)}00${c(0x200b)}000`],
    ['soft hyphen between groups', `333${c(0xad)}1234567`],
    ['tab between groups', '333\t1234567'],
    ['em space between groups', `333${c(0x2003)}123${c(0x2003)}4567`],
    ['ideographic space between groups', `333${c(0x3000)}1234567`],
    ['hair space between groups', `333${c(0x200a)}123${c(0x200a)}4567`],
    ['word joiner between groups', `333${c(0x2060)}1234567`],
    ['fullwidth digits', digitsIn(0xff10)],
    ['Arabic-Indic digits', digitsIn(0x660)],
  ]
  it.each(cases)('tokenizes a phone number with %s', (_label, number) => {
    const p = new Pseudonymizer([])
    const out = p.pseudonymize(`tel ${number} fine`)
    expect(out).toBe('tel [TELEFONO_1] fine')
    expect(p.restore(out)).toBe(`tel ${number} fine`)
  })

  it('still lets a real date after a wide space end the candidate', () => {
    const wide = String.fromCodePoint(0x2003)
    const out = new Pseudonymizer([]).pseudonymize(`12 34 56 78${wide}04.11.2026`)
    expect(out).toBe(`[TELEFONO_1]${wide}04.11.2026`)
  })

  it('does not join digits across a line break', () => {
    expect(new Pseudonymizer([]).pseudonymize('1234\n5678')).toBe('1234\n5678')
  })
})

describe('pseudonymizer emails with a comma in the local part', () => {
  // Found by review: the loose fallback stopped at the comma and left "a," in clear.
  it.each([
    ['a,b@x.it', '[EMAIL_1]'],
    ['mario.rossi,b@x.it', '[EMAIL_1]'],
    ['scrivi a a,b@x.it oggi', 'scrivi a [EMAIL_1] oggi'],
    ['x,y,z@dominio.example', '[EMAIL_1]'],
  ])('tokenizes the whole address in %s', (text, expected) => {
    const p = new Pseudonymizer([])
    const out = p.pseudonymize(text)
    expect(out).toBe(expected)
    expect(p.restore(out)).toBe(text)
  })

  it('swallows a quoted local part that follows a comma', () => {
    const out = new Pseudonymizer([]).pseudonymize('x@a.it,"Mario Rossi"@b.it')
    expect(out).not.toContain('Mario')
    expect(out).not.toContain('Rossi')
    expect(out).not.toContain('@')
    expect(out).toBe('[EMAIL_1],[EMAIL_2]')
  })

  it('still splits a comma-separated list of addresses into one token each', () => {
    const p = new Pseudonymizer([])
    expect(p.pseudonymize('x@a.it,y@b.it')).toBe('[EMAIL_1],[EMAIL_2]')
    expect(p.pseudonymize('x@a.it, y@b.it; z@c.it')).toBe('[EMAIL_1], [EMAIL_2]; [EMAIL_3]')
  })
})

describe('pseudonymizer and the emails of known people', () => {
  it('hides the user name of a known email also when it appears alone', () => {
    const p = new Pseudonymizer([
      { displayName: 'Ottavio Brambilla', email: 'obrambilla@contoso.example' },
    ])
    const text = 'Assegnato a @obrambilla (obrambilla@contoso.example), poi a Ottavio'
    const out = p.pseudonymize(text)
    expect(out).not.toContain('obrambilla')
    expect(out).not.toContain('Ottavio')
    expect(out).not.toContain('contoso')
    expect(p.restore(out)).toBe(text)
  })

  it('takes no user name shorter than a name part', () => {
    const p = new Pseudonymizer([{ displayName: 'Ada Neri', email: 'an@contoso.example' }])
    expect(p.pseudonymize('an anno')).toBe('an anno')
  })
})

describe('pseudonymizer and names that are not only names', () => {
  it('never hides a number as a name, even as the user name of an email', () => {
    const p = new Pseudonymizer([{ displayName: 'Ada Neri', email: '12345@contoso.example' }])
    expect(p.pseudonymize('ordine 12345 di Ada')).toBe('ordine 12345 di [PERSONA_1]')
  })

  it('tokenizes an email whole when a name runs into it', () => {
    const p = new Pseudonymizer([{ displayName: 'Mario Rossi' }])
    const text = 'Mario Rossi.x@contoso.it ha scritto'
    const out = p.pseudonymize(text)
    expect(out).not.toMatch(/contoso|x@/)
    expect(out).not.toMatch(/Mario|Rossi/)
    expect(p.restore(out)).toBe(text)
  })

  it('matches a name written with punctuation as one token, punctuation included', () => {
    const p = new Pseudonymizer([{ displayName: 'J. (Jo) Smith+' }, { displayName: '(Nina)' }])
    expect(p.pseudonymize('arriva J. (Jo) Smith+ oggi')).toBe('arriva [PERSONA_1] oggi')
    expect(p.pseudonymize('e (Nina) e x(Nina)')).toBe('e [PERSONA_2] e x([PERSONA_2A])')
  })

  it('shares one dictionary between instances, each with its own tokens', () => {
    const matcher = new PeopleMatcher([{ displayName: 'Mario Rossi' }, { displayName: 'Anna' }])
    const a = new Pseudonymizer(matcher)
    const b = new Pseudonymizer(matcher)
    expect(a.pseudonymize('Anna e Mario')).toBe('[PERSONA_2] e [PERSONA_1]')
    expect(b.pseudonymize('ANNA')).toBe('[PERSONA_2]')
    expect(a.restore('[PERSONA_2]')).toBe('Anna')
    expect(b.restore('[PERSONA_2]')).toBe('ANNA')
  })
})

describe('pseudonymizer and names that run into numbers', () => {
  const people = [
    { displayName: 'Mario Rossi', email: 'mrossi79@contoso.example' },
    { displayName: 'R2D2' },
  ]
  it.each([
    ['utente mrossi79 3331234567', 'utente [PERSONA_1] [TELEFONO_1]'],
    ['mrossi79-3331234567', '[PERSONA_1]-[TELEFONO_1]'],
    ['R2D2 12345678', '[PERSONA_2] [TELEFONO_1]'],
    ['mrossi79/2026/01/01', '[PERSONA_1]/2026/01/01'],
  ])('lets the name win over a number that starts inside it: %s', (text, expected) => {
    const p = new Pseudonymizer(people)
    const out = p.pseudonymize(text)
    expect(out).toBe(expected)
    expect(p.restore(out)).toBe(text)
  })

  it.each(['mrossi7933312345', 'mrossi79333123', 'tel mrossi79 333 123', 'mrossi79(02)123456'])(
    'hides what is left of the number after the name: %s',
    (text) => {
      const p = new Pseudonymizer(people)
      const out = p.pseudonymize(text)
      expect(out).toMatch(/^(tel )?\[PERSONA_1\]/)
      expect(out.replace(/\[[A-Z]+_\d+[A-Z]*\]/g, '')).not.toMatch(/\d/)
      expect(p.restore(out)).toBe(text)
    },
  )

  it('hides a name glued to the number or the date that follows it', () => {
    const p = new Pseudonymizer(people)
    expect(p.pseudonymize('Rossi12345678 e Rossi2026-01-01')).toBe(
      '[PERSONA_1][TELEFONO_1] e [PERSONA_1]2026-01-01',
    )
  })

  it('still finds a number glued to a word that is not a name', () => {
    expect(new Pseudonymizer(people).pseudonymize('ref12345678 ok')).toBe('ref[TELEFONO_1] ok')
  })

  it.each([
    ['Luca99 12345678.giulia@private.example', '[PERSONA_3] [EMAIL_1]'],
    ['mrossi79 3331234567@contoso.it', '[PERSONA_1] [EMAIL_1]'],
    ['Luca99  3331234567—10:30.Luca99(mrossi79@contoso.it…', '[PERSONA_3]  [EMAIL_1]'],
    ['Luca99 3331234567—10:30 ok', '[PERSONA_3] [TELEFONO_1]:30 ok'],
    ['mrossi79 333123[LITERAL_1]', '[PERSONA_1] [TELEFONO_1][LITERAL_1]'],
  ])(
    'resolves an email, a time or a literal starting inside the rest of the number, and restores it: %s',
    (text, expected) => {
      const p = new Pseudonymizer([...people, { displayName: 'Luca99' }])
      const out = p.pseudonymize(text)
      expect(out).toBe(expected)
      expect(p.restore(out)).toBe(text)
    },
  )

  it.each([
    ['mrossi79 333-2026-01-01-1234567', '[PERSONA_1] [TELEFONO_1]'],
    ['mrossi79 333.01.02.2026.1234567', '[PERSONA_1] [TELEFONO_1]'],
    ['Luca99 1234-2026-01-01-5678', '[PERSONA_2] [TELEFONO_1]'],
    ['Luca991234567/333—2026-01-01 1234.333 mario(', '[PERSONA_2][TELEFONO_1] [PERSONA_1]('],
  ])(
    'hides the rest of the number whole when a date sits inside its digits: %s',
    (text, expected) => {
      const p = new Pseudonymizer([
        { displayName: 'Mario Rossi', email: 'mrossi79@contoso.example' },
        { displayName: 'Luca99' },
      ])
      const out = p.pseudonymize(text)
      expect(out).toBe(expected)
      expect(out.replace(/\[[A-Z]+_\d+[A-Z]*\]/g, '')).not.toMatch(/\d/)
      expect(p.restore(out)).toBe(text)
    },
  )

  it('treats a date at the end of the rest of a number as the number does alone', () => {
    const alone = new Pseudonymizer(people).pseudonymize('3331234567-2026-01-01')
    const p = new Pseudonymizer(people)
    const text = 'mrossi79 3331234567-2026-01-01'
    const out = p.pseudonymize(text)
    expect(out).toBe(`[PERSONA_1] ${alone}`)
    expect(out.replace(/\[[A-Z]+_\d+[A-Z]*\]/g, '')).not.toMatch(/\d/)
    expect(p.restore(out)).toBe(text)
  })

  it(
    'stays linear on one long word full of numbers, dates and glued names',
    () => {
      const crowd = [
        ...people,
        { displayName: 'Luca99' },
        ...Array.from({ length: 62 }, (_, i) => ({ displayName: `${'q'.repeat(i + 2)}z` })),
      ]
      const p = new Pseudonymizer(crowd)
      const size = 256 * 1024
      const inputs = [
        `x${'12345678x'.repeat(size / 9)}`,
        `${'q'.repeat(63)}12345678`.repeat(size / 71),
        `a${'2026-01-01a'.repeat(size / 11)}`,
        `a${'1:30a'.repeat(size / 5)}`,
        `Luca99${'12345678Luca'.repeat(size / 12)}`,
      ]
      for (const input of inputs) {
        const { slope, largeMs } = growthSlope((fraction) => {
          const part = input.slice(0, Math.round(input.length * fraction))
          return () => p.pseudonymize(part)
        })
        expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs).toBeLessThan(HANG_GUARD_MS)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})

describe('pseudonymizer and very long names', () => {
  it('hides the short words of a name of more than twelve words', () => {
    const words = [
      'Al',
      'Bo',
      'Ci',
      'Do',
      'Ed',
      'Fa',
      'Gi',
      'Ho',
      'Il',
      'Jo',
      'Ka',
      'Lu',
      'Mo',
      'No',
    ]
    const name = words.join(' ')
    const p = new Pseudonymizer([{ displayName: name }])
    const out = p.pseudonymize(`firma: ${name}.`)
    expect(out).toBe('firma: [PERSONA_1].')
  })

  it('leaves nothing of a name of forty short words in clear', () => {
    const words = Array.from({ length: 40 }, (_, i) => `Q${String.fromCharCode(97 + (i % 26))}`)
    const name = words.join(' ')
    const p = new Pseudonymizer([{ displayName: name }])
    const out = p.pseudonymize(`firma: ${name}.`)
    expect(out).toMatch(/^firma: (\[PERSONA_1[A-Z]*\]\s*)+\.$/)
    expect(p.restore(out)).toBe(`firma: ${name}.`)
  })
})

describe('pseudonymizer and names with punctuation words', () => {
  it.each([
    ['Li & Xu', 'firmato da Li & Xu ieri'],
    ['Anna – Bo', 'presenti: Anna – Bo, poi altri'],
  ])('hides every word of %s in context', (displayName, text) => {
    const p = new Pseudonymizer([{ displayName }])
    const out = p.pseudonymize(text)
    for (const word of displayName.split(' ').filter((w) => /\p{L}/u.test(w))) {
      expect(out).not.toContain(word)
    }
    expect(p.restore(out)).toBe(text)
  })
})

describe('pseudonymizer with very many people', () => {
  const crowd = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      displayName: `Nome${i} Secondo${i} De Cognome${i}`,
      email: `utente${i}@contoso.example`,
    }))

  it('fails closed with pseudonymization_unavailable past the dictionary limit', () => {
    expect(() => new Pseudonymizer(crowd(MAX_DICTIONARY_PEOPLE + 1))).toThrow(
      expect.objectContaining({ code: 'pseudonymization_unavailable' }),
    )
  })

  it(
    'hides names among as many people as it holds, in text with two-byte characters',
    () => {
      const matcher = new PeopleMatcher(crowd(MAX_DICTIONARY_PEOPLE))
      const line = 'L’incontro con Nome49999 De Cognome49999 — rinviato 🙂 da utente7. '
      const text = line.repeat(Math.ceil(100_000 / line.length))
      const p = new Pseudonymizer(matcher)
      const out = p.pseudonymize(text)
      expect(out).not.toMatch(/Nome49999|Cognome49999|utente7/)
      expect(out).toContain('L’incontro')
      expect(p.restore(out)).toBe(text)
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})
