import { describe, expect, it } from 'vitest'
import { checkRule, type HttpRule, rulesAllow } from '../src/rules.ts'
import { assertRulesConfined } from './support/rules-contract.ts'

const lit = (...names: string[]) => names.map((literal) => ({ literal }))
const allows = (rule: HttpRule, url: string) => rulesAllow([checkRule(rule)], 'GET', new URL(url))

describe('the host of a rule', () => {
  it('takes a port from 1 to 65535', () => {
    expect(() => checkRule({ method: 'GET', host: 'h.example:8443', path: lit('x') })).not.toThrow()
    for (const host of ['h.example:0', 'h.example:65536', 'h.example:99999', 'h.example:']) {
      expect(() => checkRule({ method: 'GET', host, path: lit('x') }), host).toThrow(TypeError)
    }
  })

  it('refuses a default port, which a URL never carries', () => {
    for (const host of ['dev.azure.com:443', 'dev.azure.com:80']) {
      expect(() => checkRule({ method: 'GET', host, path: lit('x') })).toThrow(/default port/)
    }
  })
})

describe('literal segments', () => {
  const rule: HttpRule = { method: 'GET', host: 'h.example', path: lit('Progetto Ünità', 'items') }

  it('match spaces and non-ASCII letters as the URL encodes them', () => {
    expect(allows(rule, 'https://h.example/Progetto%20%C3%9Cnit%C3%A0/items')).toBe(true)
    expect(allows(rule, 'https://h.example/Progetto Ünità/items')).toBe(true)
    expect(allows(rule, 'https://h.example/Progetto%20Unita/items')).toBe(false)
  })

  it('refuse a path segment that is not in composed form (NFC)', () => {
    // Ü as U followed by a combining diaeresis (NFD): the bytes sent are not the literal's.
    expect(allows(rule, 'https://h.example/Progetto%20U%CC%88nit%C3%A0/items')).toBe(false)
    const decomposed = 'Progetto Ünità'.normalize('NFD')
    expect(allows(rule, `https://h.example/${decomposed}/items`)).toBe(false)
    const any: HttpRule = { method: 'GET', host: 'h.example', path: [...lit('a', 'b'), 'segment'] }
    expect(allows(any, 'https://h.example/a/b/U%CC%88')).toBe(false)
    expect(allows(any, 'https://h.example/a/b/%C3%9C')).toBe(true)
  })

  it('must be in composed form (NFC) when the rule is made', () => {
    const decomposed = 'Progetto Ünità'.normalize('NFD')
    expect(() => checkRule({ method: 'GET', host: 'h.example', path: lit(decomposed) })).toThrow(
      /plain literal/,
    )
  })

  it('keep an encoded percent as text: %252F is never a slash', () => {
    const one: HttpRule = { method: 'GET', host: 'h.example', path: [...lit('a', 'b'), 'segment'] }
    expect(allows(one, 'https://h.example/a/b/x%252Fy')).toBe(true)
    const literal: HttpRule = { method: 'GET', host: 'h.example', path: lit('a', '%2F') }
    expect(allows(literal, 'https://h.example/a/%252F')).toBe(true)
    expect(allows(literal, 'https://h.example/a/%2F')).toBe(false)
    const split: HttpRule = { method: 'GET', host: 'h.example', path: lit('a', 'x', 'y') }
    expect(allows(split, 'https://h.example/a/x%252Fy')).toBe(false)
  })
})

describe('the rules contract', () => {
  type Cfg = { org: string }
  const cfg = (value: string): Cfg => ({ org: value })

  it('passes rules that keep every configuration value a literal', () => {
    assertRulesConfined(
      (c: Cfg) => [
        { method: 'GET', host: 'dev.azure.com', path: [...lit(c.org, '_apis', 'wit'), 'segment'] },
        { method: 'GET', host: 'dev.azure.com', path: lit(c.org, '_apis', 'files'), rest: true },
      ],
      cfg,
    )
  })

  it('fails rules that turn a value into an id placeholder', () => {
    expect(() =>
      assertRulesConfined(
        (c: Cfg) => [
          {
            method: 'GET',
            host: 'dev.azure.com',
            path: [
              { literal: 'apps' },
              /[*.|]/.test(c.org) ? 'segment' : { literal: c.org },
              { literal: 'items' },
            ],
          },
        ],
        cfg,
      ),
    ).toThrow(/changes the shape of the rules/)
  })

  it('fails rules that move the rest right after the value', () => {
    expect(() =>
      assertRulesConfined(
        (c: Cfg): HttpRule[] =>
          c.org.includes('.')
            ? [{ method: 'GET', host: 'dev.azure.com', path: lit('apps', c.org), rest: true }]
            : [{ method: 'GET', host: 'dev.azure.com', path: lit('apps', c.org, 'items') }],
        cfg,
      ),
    ).toThrow(/changes the shape of the rules/)
  })

  it('fails rules that build literals from the raw value', () => {
    expect(() =>
      assertRulesConfined(
        (c: Cfg) => [
          {
            method: 'GET',
            host: 'dev.azure.com',
            path: [...c.org.split('/').map((literal) => ({ literal })), { literal: 'items' }],
          },
        ],
        cfg,
      ),
    ).toThrow(/changes the shape of the rules/)
  })
})
