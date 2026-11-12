import { newId, type ProjectId } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import {
  cachedPeopleNames,
  MAX_CACHED_NAMES,
  peopleMatcherFor,
} from '../src/model/people-matchers.ts'

const crowd = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({ displayName: `${tag}${i} Cognome${i}` }))

describe('the cached dictionaries of the people', () => {
  it('reuse one dictionary for the same list and build another when the list changes', () => {
    const project = newId<ProjectId>()
    const a = peopleMatcherFor(project, [{ displayName: 'Mario Rossi' }])
    expect(peopleMatcherFor(project, [{ displayName: 'Mario Rossi' }])).toBe(a)
    expect(peopleMatcherFor(project, [{ displayName: 'Mario Rossi', email: 'm@x.it' }])).not.toBe(a)
    expect(peopleMatcherFor(newId<ProjectId>(), [{ displayName: 'Mario Rossi' }])).not.toBe(a)
    // The same name trusted otherwise registers other aliases: another dictionary.
    const seen = peopleMatcherFor(project, [{ displayName: 'Mario Rossi', trust: 'seen' }])
    expect(seen).not.toBe(a)
    expect(
      peopleMatcherFor(project, [{ displayName: 'Mario Rossi', trust: 'untrusted' }]),
    ).not.toBe(seen)
  })

  it('hold at most a bounded number of names together', () => {
    for (let i = 0; i < 5; i += 1) {
      peopleMatcherFor(newId<ProjectId>(), crowd(40_000, `P${i}x`))
      expect(cachedPeopleNames()).toBeLessThanOrEqual(MAX_CACHED_NAMES)
    }
  }, 60_000)
})
