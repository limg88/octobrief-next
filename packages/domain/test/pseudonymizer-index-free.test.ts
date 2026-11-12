import { describe, expect, it } from 'vitest'
import { PeopleMatcher, Pseudonymizer } from '../src/recipe/index.ts'

const people = [
  { displayName: 'Mario Rossi', email: 'mario.rossi@example.com' },
  { displayName: 'Anna Bianchi' },
]

describe('pseudonymizer with index-free placeholders', () => {
  it('hides names, emails and phones with placeholders that carry no position', () => {
    const p = new Pseudonymizer(people, { placeholders: 'index-free' })
    const out = p.pseudonymize(
      'Mario Rossi: mario.rossi@example.com, +39 333 1234567; parla con Anna Bianchi e Rossi',
    )
    expect(out).toBe('[PERSONA]: [EMAIL], [TELEFONO]; parla con [PERSONA] e [PERSONA]')
  })

  it('gives the same text whatever the order or length of the people list', () => {
    const text = 'Anna Bianchi scrive a Mario Rossi il 12/03/2026'
    const a = new Pseudonymizer(people, { placeholders: 'index-free' }).pseudonymize(text)
    const reordered = [{ displayName: 'Luca Verdi' }, ...[...people].reverse()]
    const b = new Pseudonymizer(reordered, { placeholders: 'index-free' }).pseudonymize(text)
    expect(a).toBe('[PERSONA] scrive a [PERSONA] il 12/03/2026')
    expect(b).toBe(a)
  })

  it('uses the same recognizers as the indexed mode: the hidden spans are the same', () => {
    const matcher = new PeopleMatcher(people)
    const text = 'mrossi79 3331234567, Rossi12345678, [PERSONA_1] e mario.rossi@example.com'
    const indexed = new Pseudonymizer(matcher).pseudonymize(text)
    const free = new Pseudonymizer(matcher, { placeholders: 'index-free' }).pseudonymize(text)
    const strip = (s: string) =>
      s.replace(/\[(PERSONA|EMAIL|TELEFONO|LITERAL)(_\d+[A-Z]*)?\]/g, '[$1]')
    expect(free).toBe(strip(indexed))
    expect(free).not.toContain('Rossi')
    expect(free).not.toContain('333')
  })

  it('keeps no mapping: an index-free text cannot be restored', () => {
    const p = new Pseudonymizer(people, { placeholders: 'index-free' })
    p.pseudonymize('Mario Rossi')
    expect(() => p.restore('[PERSONA]')).toThrow()
  })

  it('leaves the default mode indexed and restorable', () => {
    const p = new Pseudonymizer(people, { placeholders: 'indexed' })
    expect(p.pseudonymize('Mario Rossi')).toBe('[PERSONA_1]')
    expect(p.restore('[PERSONA_1]')).toBe('Mario Rossi')
  })
})
