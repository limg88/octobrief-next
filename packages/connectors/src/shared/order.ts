import { ConnectorError } from '../errors.ts'

/**
 * A check that the items of an answer come in the order the cursor is a position in. An item
 * before the previous one (or, when `strict`, equal to it) fails the batch with
 * `source_bad_response`: an answer out of order could make the cursor skip items, so no batch
 * comes out and the cursor stays where it was.
 */
export function orderGuard<K>(
  compare: (a: K, b: K) => number,
  { strict }: { strict: boolean },
): (key: K) => void {
  let previous: { key: K } | null = null
  return (key) => {
    if (previous !== null) {
      const order = compare(previous.key, key)
      if (order > 0 || (strict && order === 0)) throw new ConnectorError('source_bad_response')
    }
    previous = { key }
  }
}
