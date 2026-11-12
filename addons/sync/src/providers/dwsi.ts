import {
  ConnectorError,
  createNetGuard,
  type DatabaseTls,
  dwsiConnector,
  prjOption,
  SecretValue,
  toDelivery,
} from '@octobrief/connectors'
import { MAX_ITEMS_PER_DELIVERY } from '@octobrief/domain'
import { FeederError, type Provider } from '../feeder.ts'
import { toWire } from '../wire.ts'

export interface DwsiOptions {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  /** Read-only credentials of the warehouse; never sent to the server. */
  readonly password: string
  /** Project codes (`PRJ000123`) to read. */
  readonly projectCodes: readonly string[]
  /** The PM the perimeter is bound to: only projects that person works on are read. */
  readonly ownerEmail: string
  /** How the connection is secured; the warehouse's own (weaker) mode stays on this computer. */
  readonly tls: DatabaseTls
  readonly allowLoopback?: boolean
}

/** Batches one run reads at most. */
const MAX_BATCHES = 200

/**
 * The data warehouse, read from the PM's computer with read-only credentials: the connection the
 * warehouse offers never leaves this machine, and the server only receives what was read.
 */
export function dwsiProvider(options: DwsiOptions): Provider {
  return {
    name: 'dwsi',
    async *deliveries() {
      const perimeter = options.projectCodes.map(prjOption)
      const signal = new AbortController().signal
      try {
        const config = dwsiConnector.parseConfig({
          host: options.host,
          port: options.port,
          database: options.database,
          user: options.user,
          projectCodes: [...options.projectCodes],
        })
        const ctx = {
          config,
          perimeter,
          secret: new SecretValue(options.password),
          // The warehouse is not reached over HTTP: any HTTP call is a defect, and is refused.
          http: {
            request: () => Promise.reject(new ConnectorError('call_blocked')),
            getJson: () => Promise.reject(new ConnectorError('call_blocked')),
            postJson: () => Promise.reject(new ConnectorError('call_blocked')),
            close: () => {},
          },
          net: createNetGuard({
            privateHosts: [{ host: config.host, databaseTls: options.tls, caPem: null }],
            onBlocked: async () => {},
            allowLoopback: options.allowLoopback === true,
          }),
          signal,
          now: () => new Date(),
          owner: { email: options.ownerEmail },
        }
        let cursor: Parameters<typeof dwsiConnector.sync>[1] = null
        for (let batch = 0; batch < MAX_BATCHES; batch++) {
          const read = await dwsiConnector.sync(ctx, cursor, {
            maxItems: MAX_ITEMS_PER_DELIVERY,
            signal,
          })
          yield toWire(toDelivery(read, new Set(perimeter)))
          cursor = read.nextCursor
          if (read.done) return
        }
      } catch (error) {
        if (error instanceof ConnectorError) {
          const reason = error.reason ? ` (${error.reason})` : ''
          throw new FeederError('provider_failed', `warehouse: ${error.code}${reason}`)
        }
        throw error
      }
    },
  }
}
