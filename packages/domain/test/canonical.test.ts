import { describe, expect, it } from 'vitest'
import { canonicalText } from '../src/index.ts'

describe('canonicalText', () => {
  it('removes invisible format characters that split words and numbers', () => {
    expect(canonicalText('Mario\u200bRossi')).toBe('MarioRossi')
    expect(canonicalText('AC\u00adME')).toBe('ACME')
    expect(canonicalText('nov\u200bembre')).toBe('novembre')
    expect(canonicalText('€\u200b5')).toBe('€5')
    expect(canonicalText('1\u200b200')).toBe('1200')
    expect(canonicalText('a\u2060b\ufeffc\u200dd')).toBe('abcd')
  })

  it('removes the default-ignorable code points that are not format characters', () => {
    const ignorables = [
      '\u034f',
      '\u115f',
      '\u1160',
      '\u17b4',
      '\u17b5',
      '\u180b',
      '\u180f',
      '\u3164',
      '\ufe00',
      '\ufe0f',
      '\uffa0',
      '\u{e0001}',
      '\u{e0100}',
      '\u{e0fff}',
    ]
    for (const ch of ignorables)
      expect(canonicalText(`x${ch}y`), ch.codePointAt(0)?.toString(16)).toBe('xy')
  })

  it('applies NFKC, collapses whitespace and trims', () => {
    expect(canonicalText('  ﬁne\u00a0\u00a0 ３  \n\t')).toBe('fine 3')
  })

  it('leaves nothing of a text made only of invisible characters', () => {
    expect(canonicalText('\u200b')).toBe('')
    expect(canonicalText(' \u200b\u00ad ')).toBe('')
  })
})
