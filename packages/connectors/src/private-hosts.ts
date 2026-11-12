import { createHash, X509Certificate } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { DomainError } from '@octobrief/domain'
import { classifyAddress } from './addresses.ts'

/**
 * How a connection to a database on a private host is secured:
 * - `verify_full`: TLS, the certificate checked against the host name (the default);
 * - `unverified`: TLS without checking the certificate;
 * - `plaintext`: no TLS at all.
 * Only the Admin lowers it from `verify_full`, host by host.
 */
export const DATABASE_TLS_MODES = ['verify_full', 'unverified', 'plaintext'] as const
export type DatabaseTls = (typeof DATABASE_TLS_MODES)[number]

/**
 * A host name on a private network the Admin allows the connectors to reach. Connectors refuse
 * private addresses; for a host on this list they accept one, still pinned to the address the
 * name resolved to, and never a loopback, link-local or metadata address.
 */
export interface PrivateHost {
  /** A DNS name in lower case: never an IP address, a port or a wildcard. */
  host: string
  databaseTls: DatabaseTls
  /** A PEM certificate authority the database certificate is checked against (`verify_full`). */
  caPem: string | null
}

export const MAX_PRIVATE_HOSTS = 50
/** Characters of a certificate authority at most, and certificates in it (a chain). */
export const MAX_CA_LENGTH = 16_384
export const MAX_CA_CERTIFICATES = 5
const KNOWN_FIELDS = new Set(['host', 'databaseTls', 'caPem'])
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PEM_BLOCK =
  '-----BEGIN CERTIFICATE-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+)-----END CERTIFICATE-----'
/** One PEM certificate or several, one after the other (an authority and those it signed). */
const PEM_CERTIFICATES = new RegExp(`^${PEM_BLOCK}(?:(?:\\r?\\n)+${PEM_BLOCK})*\\r?\\n?$`)

const invalid = () => new DomainError('private_host_invalid')

/** The base64 content of each certificate of a PEM text, in order. */
function pemBodies(pem: string): string[] {
  return [...pem.matchAll(new RegExp(PEM_BLOCK, 'g'))].map((m) => (m[1] ?? '').replace(/\s/g, ''))
}

/** Whether a stored certificate authority has a shape the list accepts. */
function caPemShaped(pem: string): boolean {
  return (
    pem.length <= MAX_CA_LENGTH &&
    PEM_CERTIFICATES.test(pem) &&
    pemBodies(pem).length <= MAX_CA_CERTIFICATES
  )
}

/**
 * Reads the certificate authority the Admin pasted for a host: one PEM certificate or a chain
 * of up to {@link MAX_CA_CERTIFICATES}, each one an X.509 certificate. Spaces around the lines,
 * blank lines and Windows line ends are dropped; the text kept ends with one line end. Throws
 * `private_host_ca_too_long` beyond the limits and `private_host_ca_invalid` for anything else
 * (a private key, text around the certificates, a block that is not a certificate).
 */
export function readCaPem(raw: unknown): string {
  if (typeof raw !== 'string') throw new DomainError('private_host_ca_invalid')
  const lines = raw
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (lines.length === 0) throw new DomainError('private_host_ca_invalid')
  const pem = `${lines.join('\n')}\n`
  const bodies = pemBodies(pem)
  if (pem.length > MAX_CA_LENGTH || bodies.length > MAX_CA_CERTIFICATES) {
    throw new DomainError('private_host_ca_too_long')
  }
  if (!PEM_CERTIFICATES.test(pem)) throw new DomainError('private_host_ca_invalid')
  for (const block of pem.match(new RegExp(PEM_BLOCK, 'g')) ?? []) {
    try {
      new X509Certificate(block)
    } catch {
      throw new DomainError('private_host_ca_invalid')
    }
  }
  return pem
}

/** What the Admin sees of a certificate of an authority: never its text. */
export interface CaCertificate {
  /** SHA-256 of its DER, in upper-case hexadecimal pairs separated by colons. */
  fingerprint: string
  /** The common name of its subject and of its issuer, when it has one and can be read. */
  subject: string | null
  issuer: string | null
}

function commonName(distinguished: string): string | null {
  const line = distinguished.split('\n').find((l) => l.startsWith('CN='))
  return line ? line.slice('CN='.length) : null
}

/**
 * Describes each certificate of a stored authority: its fingerprint always (computed on the
 * bytes of the block), its names when the block reads as a certificate.
 */
export function describeCaPem(pem: string): CaCertificate[] {
  return pemBodies(pem).map((body) => {
    const der = Buffer.from(body, 'base64')
    const hex = createHash('sha256').update(der).digest('hex').toUpperCase()
    const fingerprint = hex.match(/../g)?.join(':') ?? ''
    try {
      const certificate = new X509Certificate(der)
      return {
        fingerprint,
        subject: commonName(certificate.subject),
        issuer: commonName(certificate.issuer),
      }
    } catch {
      return { fingerprint, subject: null, issuer: null }
    }
  })
}

/** A host name the list accepts, in lower case; throws `private_host_invalid` otherwise. */
export function privateHostName(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid()
  const host = raw.toLowerCase()
  if (host.length === 0 || host.length > 253) throw invalid()
  // An address instead of a name only when it is an IPv4 one of a private network.
  if (isIPv4(host)) {
    if (classifyAddress(host) !== 'private') throw invalid()
    return host
  }
  const labels = host.split('.')
  // At least two labels, each a DNS label; an all-numeric name would read as an IPv4 address.
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw invalid()
  if (labels.every((l) => /^\d+$/.test(l))) throw invalid()
  if (labels[labels.length - 1] === 'localhost') throw invalid()
  return host
}

function entryOf(raw: unknown): PrivateHost {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid()
  const fields = raw as Record<string, unknown>
  if (Object.keys(fields).some((k) => !KNOWN_FIELDS.has(k))) throw invalid()
  const host = privateHostName(fields.host)
  const databaseTls = fields.databaseTls ?? 'verify_full'
  if (!(DATABASE_TLS_MODES as readonly unknown[]).includes(databaseTls)) throw invalid()
  const caPem = fields.caPem ?? null
  if (caPem !== null) {
    if (typeof caPem !== 'string' || !caPemShaped(caPem)) throw invalid()
    // A certificate authority means the certificate is checked.
    if (databaseTls !== 'verify_full') throw invalid()
  }
  return { host, databaseTls: databaseTls as DatabaseTls, caPem: caPem as string | null }
}

/**
 * The list with the certificate authority of one host set (a text read by {@link readCaPem}),
 * replaced, or removed (`null`). Throws `private_host_unknown` for a host not on the list and
 * `private_host_ca_not_verified` for a host whose certificate is not checked.
 */
export function withHostCa(
  hosts: readonly PrivateHost[],
  host: string,
  caPem: string | null,
): PrivateHost[] {
  const name = host.toLowerCase()
  const target = hosts.find((h) => h.host === name)
  if (!target) throw new DomainError('private_host_unknown')
  if (caPem !== null && target.databaseTls !== 'verify_full') {
    throw new DomainError('private_host_ca_not_verified')
  }
  return hosts.map((h) => (h === target ? { ...h, caPem } : h))
}

/**
 * Reads the Admin's list of private hosts. Throws `private_host_invalid` for anything that is not
 * a well-formed entry, `private_host_duplicate` for a host given twice and
 * `private_hosts_too_many` beyond the limit.
 */
export function parsePrivateHosts(raw: unknown): PrivateHost[] {
  if (!Array.isArray(raw)) throw invalid()
  if (raw.length > MAX_PRIVATE_HOSTS) throw new DomainError('private_hosts_too_many')
  const hosts = raw.map(entryOf)
  if (new Set(hosts.map((h) => h.host)).size !== hosts.length) {
    throw new DomainError('private_host_duplicate')
  }
  return hosts
}
