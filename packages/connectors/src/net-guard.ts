import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { addressAllowed, classifyAddress } from './addresses.ts'
import { ConnectorError } from './errors.ts'
import type { PrivateHost } from './private-hosts.ts'
import type { BlockedCall, ResolvedAddress } from './safe-http.ts'

/** A host a connection may go to: the vetted addresses to pin it to, and the Admin's entry. */
export interface VettedHost {
  /** Every address the name resolved to, each allowed: connect to these, never resolve again. */
  addresses: ResolvedAddress[]
  /** The Admin's entry of the host: a database host is always on the list. */
  privateHost: PrivateHost
}

/**
 * The way to a connection that is not HTTP (a database): the same address policy as the safe
 * HTTP client, and stricter on the host. A host name only (never an IP literal), and always one
 * on the Admin's list, public or private: a database the connector reads is a system of record,
 * so a PM never points it at a host of their choosing. Resolved once; every address must be
 * public, or private (the host is listed), never loopback (but in the tests), link-local,
 * metadata or shared. A refusal is audited and fails with `call_blocked`.
 */
export interface NetGuard {
  vet(hostname: string, port: number, protocol: string): Promise<VettedHost>
}

export interface NetGuardOptions {
  privateHosts: readonly PrivateHost[]
  /** Audits a refused connection; awaited before the refusal is thrown. */
  onBlocked: (call: BlockedCall) => Promise<void>
  /** Loopback addresses: only the tests' fake systems. */
  allowLoopback?: boolean
  /** Resolves a host name to every address it has; the system resolver by default. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
}

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true })
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

export function createNetGuard(options: NetGuardOptions): NetGuard {
  const resolve = options.resolve ?? systemResolve
  const allowLoopback = options.allowLoopback === true
  const listed = new Map(options.privateHosts.map((h) => [h.host.toLowerCase(), h]))
  return {
    async vet(raw, port, protocol) {
      const hostname = raw.toLowerCase()
      const call: BlockedCall = {
        reason: 'address_not_allowed',
        method: protocol.toUpperCase(),
        host: `${hostname}:${port}`,
        path: '',
      }
      const literal = isIP(hostname.replace(/^\[|\]$/g, '')) !== 0
      const privateHost = listed.get(hostname) ?? null
      // An address is never a host to call, but the private IPv4 one the list names itself.
      if (hostname.length === 0 || (literal && privateHost === null)) {
        await options.onBlocked(call)
        throw new ConnectorError('call_blocked')
      }
      if (privateHost === null) {
        await options.onBlocked({ ...call, reason: 'host_not_allowed' })
        throw new ConnectorError('call_blocked')
      }
      if (literal) {
        if (classifyAddress(hostname) !== 'private') {
          await options.onBlocked(call)
          throw new ConnectorError('call_blocked')
        }
        return { addresses: [{ address: hostname, family: 4 }], privateHost }
      }
      let addresses: ResolvedAddress[]
      try {
        addresses = await resolve(hostname)
      } catch {
        throw new ConnectorError('source_unreachable')
      }
      if (addresses.length === 0) throw new ConnectorError('source_unreachable')
      const vet = { privateHost: true, allowLoopback }
      if (!addresses.every((a) => addressAllowed(classifyAddress(a.address), vet))) {
        await options.onBlocked(call)
        throw new ConnectorError('call_blocked')
      }
      return { addresses, privateHost }
    },
  }
}
