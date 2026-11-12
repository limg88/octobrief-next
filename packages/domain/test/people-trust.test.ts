import { describe, expect, it } from 'vitest'
import { type KnownPerson, knownNameForms, Pseudonymizer } from '../src/recipe/index.ts'
import { growthSlope, HANG_GUARD_MS, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

const TEXT =
  'Il budget residuo è 45.000 € al 30/11/2026; milestone M3 in rischio, go live slitta di 45 giorni.'

describe('names chosen outside the organization', () => {
  // Display names anyone can put in From, To or Cc of one mail to the project's mailbox.
  const poison: KnownPerson[] = [
    { displayName: 'budget', email: 'a@evil-synth.example', trust: 'untrusted' },
    { displayName: 'milestone', email: 'b@evil-synth.example', trust: 'untrusted' },
    { displayName: 'Go live rischio', email: 'c@evil-synth.example', trust: 'untrusted' },
    { displayName: '2026', email: 'd@evil-synth.example', trust: 'untrusted' },
    { displayName: 'giorni 45', email: 'e@evil-synth.example', trust: 'untrusted' },
    // A common word next to an uncommon one, or a word with digits: never registered either.
    { displayName: 'Budget Rischio', trust: 'untrusted' },
    { displayName: 'M3 Slitta', trust: 'untrusted' },
    { displayName: 'Rischio Budget', trust: 'untrusted' },
  ]

  it('never hide the words of the project: the dictionary is not poisoned', () => {
    const p = new Pseudonymizer([{ displayName: 'Mario Rossi' }, ...poison])
    expect(p.pseudonymize(TEXT)).toBe(TEXT)
    for (const text of ['Budget rischio alto', 'rischio budget', 'M3 slitta', 'Budget']) {
      expect(p.pseudonymize(text)).toBe(text)
    }
  })

  const hidden = (people: KnownPerson[], text: string, ...clear: string[]) => {
    const out = new Pseudonymizer(people).pseudonymize(text)
    for (const word of clear) expect(out, out).not.toContain(word)
    return out
  }
  const U = 'untrusted' as const

  it('hide the full name of a real external person in both orders, and its parts with a capital', () => {
    const lucrezia: KnownPerson[] = [
      { displayName: 'Lucrezia Fantini', email: 'lf@cliente-synth.example', trust: U },
    ]
    expect(hidden(lucrezia, 'Confermato con Lucrezia Fantini del cliente')).toBe(
      'Confermato con [PERSONA_1] del cliente',
    )
    hidden(lucrezia, 'Fantini conferma', 'Fantini')
    hidden(lucrezia, 'Ciao Lucrezia,', 'Lucrezia')
    hidden(lucrezia, 'Fantini Lucrezia', 'Fantini', 'Lucrezia')
  })

  it('hide names with particles, suffixes of the mail client and the other order', () => {
    hidden(
      [{ displayName: 'Francesca De Luca', trust: U }],
      'Francesca De Luca ha scritto; De Luca conferma',
      'Francesca',
      'Luca',
      'De Luca',
    )
    hidden(
      [{ displayName: 'Paolo Neri (Acme)', trust: U }],
      'Paolo Neri ha scritto',
      'Paolo',
      'Neri',
    )
    hidden(
      [{ displayName: 'Mario Rossi – Acme S.p.A.', trust: U }],
      'Mario Rossi conferma',
      'Mario',
      'Rossi',
    )
    hidden([{ displayName: 'Anna Galli | Contoso', trust: U }], 'Galli e Anna Galli', 'Galli')
    hidden([{ displayName: 'Ugo Riva, Acme Srl', trust: U }], 'Ugo Riva scrive', 'Ugo', 'Riva')
    hidden(
      [{ displayName: 'Verdi, Giulia', trust: U }],
      'Giulia Verdi conferma; Verdi, Giulia',
      'Giulia',
      'Verdi',
    )
    hidden(
      [{ displayName: "Gianluca D'Amico", trust: U }],
      "Gianluca D'Amico ha approvato",
      'Amico',
    )
  })

  it('hide a name with a common part as a whole, never the common part alone', () => {
    const p = new Pseudonymizer([{ displayName: 'Bloccato Ferri', trust: U }])
    const out = p.pseudonymize('Bloccato Ferri ha scritto; Ferri ok; il rilascio è bloccato')
    expect(out).not.toContain('Ferri')
    expect(out).toContain('il rilascio è bloccato')
    const residuo = new Pseudonymizer([{ displayName: 'Residuo Zanetti', trust: U }])
    expect(residuo.pseudonymize('Il residuo è basso')).toBe('Il residuo è basso')
  })

  it('hide the name before what follows a comma or a slash, and without a trailing number', () => {
    hidden(
      [{ displayName: 'Mario Rossi, Ufficio Acquisti', trust: U }],
      'Mario Rossi ha scritto; Rossi ok',
      'Mario',
      'Rossi',
    )
    hidden([{ displayName: 'Mario Rossi/Acme', trust: U }], 'Mario Rossi ha scritto', 'Rossi')
    hidden([{ displayName: 'Mario Rossi 2', trust: U }], 'Mario Rossi ha scritto', 'Rossi')
    hidden(
      [{ displayName: 'Rossi, Mario, Acme', trust: U }],
      'Mario Rossi ha scritto',
      'Mario',
      'Rossi',
    )
  })

  it(
    'build the names of outsiders in linear time, whatever spaces a display name holds',
    () => {
      for (const count of [5_000, 20_000]) {
        const people = Array.from({ length: count }, (_, i) => ({
          displayName: `Mario${'\t '.repeat(495)}x${i}`,
          trust: U,
        }))
        const start = performance.now()
        new Pseudonymizer(people)
        for (const person of people.slice(0, 5_000)) knownNameForms(person)
        expect(performance.now() - start).toBeLessThan(HANG_GUARD_MS)
      }
      // CPU time grows linearly with the number of crafted names (fitted up to 20,000); the
      // wall-clock hang guard above stays at 20,000 so a loaded CI runner cannot trip it.
      const crafted = growthSlope((fraction) => {
        const people = Array.from({ length: Math.round(20_000 * fraction) }, (_, i) => ({
          displayName: `Mario${'\t '.repeat(495)}x${i}`,
          trust: U,
        }))
        return () => {
          new Pseudonymizer(people)
        }
      })
      expect(crafted.slope).toBeLessThan(MAX_GROWTH_SLOPE)
      expect(crafted.largeMs).toBeLessThan(HANG_GUARD_MS)
      for (const shape of [
        (n: number) => `Mario${' '.repeat(n)}x`,
        (n: number) => `Mario Rossi${' '.repeat(n)}(Acme`,
        (n: number) => `Mario${' -'.repeat(n)} x`,
        (n: number) => `Mario Rossi,${' '.repeat(n)}x`,
      ]) {
        const { slope, largeMs } = growthSlope((fraction) => {
          const person = { displayName: shape(Math.round(40_000 * fraction)), trust: U }
          return () => {
            new Pseudonymizer([person])
            knownNameForms(person)
          }
        })
        expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs).toBeLessThan(HANG_GUARD_MS)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it('never hide a word of the text written in lower case for a part of an outsider', () => {
    const p = new Pseudonymizer([{ displayName: 'Rinviato Neri', trust: U }])
    expect(p.pseudonymize('il progetto è rinviato')).toBe('il progetto è rinviato')
    expect(p.pseudonymize('Rinviato Neri scrive')).not.toContain('Neri')
  })

  it('a member with the same part is hidden in any case', () => {
    const p = new Pseudonymizer([
      { displayName: 'Lucrezia Fantini', trust: U },
      { displayName: 'Carlo Fantini' },
    ])
    expect(p.pseudonymize('ne parla fantini')).not.toContain('fantini')
  })

  it('never register a single word as a name', () => {
    const p = new Pseudonymizer([{ displayName: 'Ottavio', trust: 'untrusted' }])
    expect(p.pseudonymize('Ottavio scrive')).toBe('Ottavio scrive')
  })
})

describe('names a source of the organization saw', () => {
  it('hide the name and its parts, but never a common word of the project', () => {
    const p = new Pseudonymizer([
      { displayName: 'Anna Riva', trust: 'seen' },
      { displayName: 'Budget', trust: 'seen' },
      { displayName: 'Stato Progetto', trust: 'seen' },
      { displayName: 'Marco Costo', trust: 'seen' },
    ])
    expect(p.pseudonymize('Riva e Anna Riva')).toMatch(/^\[PERSONA_1A?\] e \[PERSONA_1A?\]$/)
    expect(p.pseudonymize('budget e stato progetto')).toBe('budget e stato progetto')
    // The full name is hidden, the part that is a common word alone is not.
    expect(p.pseudonymize('Marco Costo, costo, Marco')).toMatch(
      /^\[PERSONA_\d+A?\], costo, \[PERSONA_\d+[AB]?\]$/,
    )
  })
})

describe('members and people the knowledge names', () => {
  it('keep every alias, common words included', () => {
    const p = new Pseudonymizer([{ displayName: 'Rosa Stato' }])
    expect(p.pseudonymize('Stato e Rosa')).toMatch(/^\[PERSONA_1A?\] e \[PERSONA_1A?\]$/)
  })
})

describe('names of two words with a short part', () => {
  it('are hidden in either order', () => {
    for (const trust of [undefined, 'seen', 'untrusted'] as const) {
      const p = new Pseudonymizer([{ displayName: 'Li Xu', ...(trust ? { trust } : {}) }])
      expect(p.pseudonymize('Xu Li e Li Xu'), String(trust)).toMatch(
        /^\[PERSONA_1A?\] e \[PERSONA_1A?\]$/,
      )
    }
  })
})

describe('the names the answer check counts as people', () => {
  it('follow the same trust as the dictionary', () => {
    expect(knownNameForms({ displayName: 'Budget', trust: 'untrusted' })).toEqual({
      forms: [],
      capitalForms: [],
    })
    expect(
      knownNameForms({ displayName: 'Budget Rischio', email: 'b@x.it', trust: 'untrusted' }),
    ).toEqual({ forms: ['b@x.it'], capitalForms: [] })
    const neri = knownNameForms({
      displayName: 'Paolo Neri (Acme)',
      email: 'pn@acme.example',
      trust: 'untrusted',
    })
    expect(neri.forms).toEqual(
      expect.arrayContaining(['Paolo Neri', 'Neri Paolo', 'pn@acme.example']),
    )
    // The parts of an outsider count only written with a capital, as in the dictionary.
    expect(neri.capitalForms).toEqual(['Paolo', 'Neri'])
    expect(knownNameForms({ displayName: 'Marco Costo', trust: 'seen' }).forms).toEqual([
      'Marco Costo',
      'Marco',
    ])
    expect(knownNameForms({ displayName: 'Rosa Stato', email: 'r@x.it' }).forms).toEqual([
      'Rosa Stato',
      'Rosa',
      'Stato',
      'r@x.it',
    ])
  })
})
