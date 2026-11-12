import { ConnectorError } from '../errors.ts'
import type { ExternalPerson } from '../port.ts'

/** Fails the call: what the source answered is not what the connector reads. */
export const bad = (): never => {
  throw new ConnectorError('source_bad_response')
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A text value in composed Unicode form (NFC), or null when it is not a text. */
export const text = (v: unknown): string | null =>
  typeof v === 'string' ? v.normalize('NFC') : null

/** A finite number, or null. */
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** An instant the source wrote as a text, or null when it is not one. */
export const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The people of a list, each once (same name and email). */
export function uniquePeople(people: readonly ExternalPerson[]): ExternalPerson[] {
  const byName = new Map<string, ExternalPerson>()
  for (const p of people) byName.set(`${p.displayName}\u0000${p.email ?? ''}`, p)
  return [...byName.values()]
}
