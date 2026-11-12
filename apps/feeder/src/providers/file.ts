import { readFile } from 'node:fs/promises'
import { FeederError, type Provider } from '../feeder.ts'
import type { WireDelivery } from '../wire.ts'

const LISTS = ['documents', 'records', 'rows', 'removed'] as const

function asDelivery(raw: unknown, path: string): WireDelivery {
  const isObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
  const fields = (isObject ? raw : {}) as Record<string, unknown>
  const wellFormed = LISTS.every(
    (list) => fields[list] === undefined || Array.isArray(fields[list]),
  )
  if (!isObject || !wellFormed) {
    throw new FeederError('provider_failed', `${path} is not a delivery`)
  }
  return fields as WireDelivery
}

/**
 * A delivery already written as JSON (one object, or an array of them): what another tool
 * exported, or the items of a demo. The server validates every field.
 */
export function fileProvider(path: string): Provider {
  return {
    name: 'file',
    async *deliveries() {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        throw new FeederError('provider_failed', `${path} is not readable JSON`)
      }
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) yield asDelivery(entry, path)
    },
  }
}
