import { expect } from 'vitest'
import { checkRule, type HttpRule, pathAllowed, segmentsOf } from '../../src/rules.ts'

/** Configuration values that would widen a rule if they were ever read as a pattern. */
export const HOSTILE_VALUES = [
  '.*',
  '.+',
  'x|y',
  '(.*)',
  '[^/]+',
  '^',
  '$',
  '..',
  '.',
  '../',
  '../../admin',
  '%2F',
  'a%2Fb',
  '%2e%2e',
  'a/b',
  '\\',
  '?',
  '#',
  '*',
  '',
  ' ',
  // Lookalikes of a slash and a dot: one literal each, never a separator.
  '／',
  'a∕b',
  '․․',
  // A decomposed name (U and a combining diaeresis): normalized to NFC, or refused.
  'Ünità',
]

/** The benign value the shape of the rules is taken from. */
const BENIGN = 'octobrief-benign-value'

function pathOf(segments: readonly string[]): string {
  return `/${segments.map(encodeURIComponent).join('/')}`
}

/** A rule written with the value in place of the benign one, part by part. */
function describeRule(rule: HttpRule, from: string, to: string): string {
  const swap = (text: string) => text.split(from).join(to)
  const parts = rule.path.map((p) => (p === 'segment' ? '<segment>' : `=${swap(p.literal)}`))
  return `${rule.method} ${swap(rule.host)} ${parts.join(' / ')}${rule.rest ? ' / <rest>' : ''}`
}

/**
 * The contract every connector's `rules(config)` must pass: whatever a configuration value holds,
 * the rules it yields are either refused (throw) or exactly the rules a benign value yields with
 * the value in its place. So a value never becomes an id placeholder (`'segment'`), never moves
 * or adds a `rest`, never adds or removes segments, and stays one literal. On top: no rule
 * allows `/`, and replacing any one literal segment (a sibling path) is not allowed.
 */
export function assertRulesConfined<Cfg>(
  rules: (config: Cfg) => readonly HttpRule[],
  configWith: (value: string) => Cfg,
): void {
  const baseline = rules(configWith(BENIGN)).map(checkRule)
  for (const value of HOSTILE_VALUES) {
    let built: HttpRule[]
    try {
      built = rules(configWith(value)).map(checkRule)
    } catch {
      continue
    }
    expect(
      built.map((r) => describeRule(r, BENIGN, BENIGN)),
      `value ${JSON.stringify(value)} changes the shape of the rules`,
    ).toEqual(baseline.map((r) => describeRule(r, BENIGN, value.normalize('NFC'))))

    const allows = (path: string) => {
      const segments = segmentsOf(path)
      return segments !== null && built.some((r) => pathAllowed(r, segments))
    }
    expect(allows('/'), `value ${JSON.stringify(value)} allows /`).toBe(false)
    for (const rule of built) {
      const shape = rule.path.map((p) => (p === 'segment' ? 'id-1' : p.literal))
      for (const [i, part] of rule.path.entries()) {
        if (part === 'segment') continue
        const sibling = shape.map((s, j) => (j === i ? 'sibling-octobrief' : s))
        expect(
          allows(pathOf(sibling)),
          `value ${JSON.stringify(value)} allows the sibling ${pathOf(sibling)}`,
        ).toBe(false)
      }
    }
  }
}
