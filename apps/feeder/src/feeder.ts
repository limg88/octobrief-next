import { MAX_ITEMS_PER_DELIVERY } from '@octobrief/domain'
import { inCalls, type WireDelivery } from './wire.ts'

/** Something on the PM's computer that can be read: a folder, a file, the warehouse, a mailbox. */
export interface Provider {
  readonly name: string
  /** What there is to deliver, one delivery at a time (a provider may read in several steps). */
  deliveries(): AsyncIterable<WireDelivery>
}

export interface Outcome {
  created: number
  updated: number
  unchanged: number
  duplicates: number
  records: number
  rows: number
  removed: number
}

export class FeederError extends Error {
  /** A stable code: `unauthorized`, `server_unreachable`, `refused_<status>`, `provider_failed`. */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FeederError'
    this.code = code
  }
}

export interface IngestClientOptions {
  /** Origin of Octobrief, such as `https://octobrief.example.com`. */
  readonly server: string
  readonly sourceId: string
  /** The token of the source: sent as a bearer credential, never logged. */
  readonly token: string
  readonly fetch?: typeof fetch
}

const HTTP_UNAUTHORIZED = 401

/** Sends one call to the ingest endpoint of the source. */
export function createIngestClient(options: IngestClientOptions) {
  const send = options.fetch ?? fetch
  const url = new URL(`/api/ingest/${encodeURIComponent(options.sourceId)}`, options.server)
  return async (delivery: WireDelivery): Promise<Outcome> => {
    let response: Response
    try {
      response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        body: JSON.stringify(delivery),
      })
    } catch {
      throw new FeederError('server_unreachable', `cannot reach ${url.origin}`)
    }
    if (response.status === HTTP_UNAUTHORIZED) {
      throw new FeederError('unauthorized', 'unknown source or wrong token')
    }
    if (!response.ok) {
      throw new FeederError(`refused_${response.status}`, `the server refused the delivery`)
    }
    return (await response.json()) as Outcome
  }
}

const ZERO: Outcome = {
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicates: 0,
  records: 0,
  rows: 0,
  removed: 0,
}

/** Reads everything the provider has and delivers it; returns the totals. */
export async function runFeeder(
  provider: Provider,
  deliver: (delivery: WireDelivery) => Promise<Outcome>,
  log: (line: string) => void = () => {},
): Promise<Outcome> {
  const total: Outcome = { ...ZERO }
  for await (const delivery of provider.deliveries()) {
    for (const call of inCalls(delivery, MAX_ITEMS_PER_DELIVERY)) {
      const outcome = await deliver(call)
      for (const key of Object.keys(total) as Array<keyof Outcome>) total[key] += outcome[key]
    }
  }
  log(
    `${provider.name}: ${total.created} nuovi, ${total.updated} aggiornati, ` +
      `${total.unchanged} invariati, ${total.duplicates} duplicati, ${total.records} record, ` +
      `${total.rows} righe`,
  )
  return total
}
