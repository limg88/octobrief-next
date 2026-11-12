import { BlockList, isIP } from 'node:net'

/**
 * Where a connector may connect: the public internet; a private network only for a host the Admin
 * allows; loopback only for the tests; never anything forbidden.
 */
export type AddressVerdict = 'public' | 'private' | 'loopback' | 'forbidden'

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

// The private networks of RFC 1918 and the IPv6 unique-local block: an on-premise system lives
// there, reachable only by a host name on the Admin's list.
const PRIVATE = new BlockList()
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')

// Shared, link-local (the cloud metadata address among them), reserved, special ranges and
// multicast: never a source system reachable from a connector, whatever the Admin allows.
const FORBIDDEN = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  // Unspecified and the deprecated IPv4-compatible block (::a.b.c.d).
  ['::', 96],
  ['fe80::', 10],
  // The deprecated site-local block: no longer assigned, never a source system.
  ['fec0::', 10],
  ['ff00::', 8],
  // NAT64: it reaches IPv4 addresses that cannot be vetted here.
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  // IPv4-translated (::ffff:0:a.b.c.d), 6to4 and Teredo: they carry an IPv4 address inside.
  ['::ffff:0:0:0', 96],
  ['2002::', 16],
  ['2001::', 32],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv6')
}
// The IPv6 metadata address of AWS: it sits inside the unique-local block, and is refused even
// for a host the Admin lists, like 169.254.169.254.
FORBIDDEN.addAddress('fd00:ec2::254', 'ipv6')

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, `::ffff:7f00:1`) stands for. */
function mappedIpv4(address: string): string | null {
  // The URL parser writes every spelling of an IPv6 address in one canonical, compressed form,
  // where a mapped address is always `::ffff:hhhh:hhhh`.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const words = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!words) return null
  const hi = Number.parseInt(words[1] as string, 16)
  const lo = Number.parseInt(words[2] as string, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Whether an IP address is public, private, loopback or forbidden. Anything unreadable is forbidden. */
export function classifyAddress(raw: string): AddressVerdict {
  const address = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const family = isIP(address)
  if (family === 0) return 'forbidden'
  if (family === 6) {
    const v4 = mappedIpv4(address)
    if (v4 !== null) return classifyAddress(v4)
    if (LOOPBACK.check(address, 'ipv6')) return 'loopback'
    if (FORBIDDEN.check(address, 'ipv6')) return 'forbidden'
    return PRIVATE.check(address, 'ipv6') ? 'private' : 'public'
  }
  if (LOOPBACK.check(address, 'ipv4')) return 'loopback'
  if (FORBIDDEN.check(address, 'ipv4')) return 'forbidden'
  return PRIVATE.check(address, 'ipv4') ? 'private' : 'public'
}

/**
 * Whether a connection may go to an address: a public one always; a private one only when the
 * host name is on the Admin's list of private hosts; loopback only when the tests allow it.
 */
export function addressAllowed(
  verdict: AddressVerdict,
  { privateHost, allowLoopback }: { privateHost: boolean; allowLoopback: boolean },
): boolean {
  if (verdict === 'public') return true
  if (verdict === 'private') return privateHost
  if (verdict === 'loopback') return allowLoopback
  return false
}
