import { createHash } from 'node:crypto'
import { type KnownPerson, PeopleMatcher, type ProjectId } from '@octobrief/domain'

/**
 * Names held at most by the cached dictionaries together (about 190 MB at 50,000 names a
 * dictionary): the least recently used is dropped first, the last one built always stays.
 */
export const MAX_CACHED_NAMES = 150_000

const cache = new Map<string, { matcher: PeopleMatcher; names: number }>()
let cachedNames = 0

/**
 * The dictionary of the people of a project, compiled once for the same list and reused by every
 * model call and tool of any run until the list changes (it is keyed by a hash of the list, in
 * order: the owners of the tokens are positions in it). Holds no state of a text.
 * `pseudonymization_unavailable` when the people cannot all be hidden.
 */
export function peopleMatcherFor(
  projectId: ProjectId,
  people: readonly KnownPerson[],
): PeopleMatcher {
  const digest = createHash('sha256')
  // The trust and the kind are part of the list: the same name trusted otherwise, or an
  // organization of the same name, is another dictionary.
  for (const p of people) {
    const entry = [p.displayName, p.email ?? null, p.trust ?? null, p.kind ?? null]
    digest.update(`${JSON.stringify(entry)}\n`)
  }
  const key = `${projectId}:${digest.digest('hex')}`
  const found = cache.get(key)
  if (found) {
    cache.delete(key)
    cache.set(key, found)
    return found.matcher
  }
  const matcher = new PeopleMatcher(people)
  cache.set(key, { matcher, names: people.length })
  cachedNames += people.length
  while (cachedNames > MAX_CACHED_NAMES && cache.size > 1) {
    const [oldest, entry] = cache.entries().next().value as [string, { names: number }]
    cache.delete(oldest)
    cachedNames -= entry.names
  }
  return matcher
}

/** How many names the cached dictionaries hold. */
export function cachedPeopleNames(): number {
  return cachedNames
}
