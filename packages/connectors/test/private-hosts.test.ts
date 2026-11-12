import { DomainError } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import {
  describeCaPem,
  MAX_CA_CERTIFICATES,
  MAX_PRIVATE_HOSTS,
  parsePrivateHosts,
  readCaPem,
  withHostCa,
} from '../src/private-hosts.ts'
import {
  TEST_ISSUING_CA,
  TEST_ISSUING_CA_FINGERPRINT,
  TEST_ROOT_CA,
  TEST_ROOT_CA_FINGERPRINT,
} from './fixtures/ca-certificates.ts'

const entry = (host: string, extra: Record<string, unknown> = {}) => ({
  host,
  databaseTls: 'verify_full',
  caPem: null,
  ...extra,
})

const CA = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n'

function refusal(raw: unknown): string {
  try {
    parsePrivateHosts(raw)
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error('accepted')
}

describe('the private hosts the Admin allows', () => {
  it('are host names in lower case, each with how its database connection is secured', () => {
    expect(
      parsePrivateHosts([
        entry('DWSI.Corp.Example'),
        entry('tracker.internal', { databaseTls: 'plaintext' }),
        entry('pg.corp.example', { caPem: CA }),
      ]),
    ).toEqual([
      { host: 'dwsi.corp.example', databaseTls: 'verify_full', caPem: null },
      { host: 'tracker.internal', databaseTls: 'plaintext', caPem: null },
      { host: 'pg.corp.example', databaseTls: 'verify_full', caPem: CA },
    ])
  })

  it('verify the certificate unless the Admin says otherwise', () => {
    expect(parsePrivateHosts([{ host: 'dwsi.internal' }])).toEqual([
      { host: 'dwsi.internal', databaseTls: 'verify_full', caPem: null },
    ])
  })

  it('may be none', () => {
    expect(parsePrivateHosts([])).toEqual([])
  })

  it('accept a private IPv4 address in place of a name', () => {
    expect(parsePrivateHosts([entry('10.0.0.5', { databaseTls: 'plaintext' })])).toEqual([
      { host: '10.0.0.5', databaseTls: 'plaintext', caPem: null },
    ])
  })

  it.each([
    ['a public IP address', '93.184.216.34'],
    ['a loopback address', '127.0.0.1'],
    ['a link-local address', '169.254.169.254'],
    ['an IPv6 address', 'fd00::1'],
    ['a bracketed IPv6 address', '[fd00::1]'],
    ['a port', 'dwsi.internal:5432'],
    ['a path', 'dwsi.internal/x'],
    ['a wildcard', '*.internal'],
    ['an empty label', 'dwsi..internal'],
    ['a trailing dot', 'dwsi.internal.'],
    ['a label starting with a hyphen', '-dwsi.internal'],
    ['a label of 64 characters', `${'a'.repeat(64)}.internal`],
    ['a name longer than 253 characters', `${'a.'.repeat(127)}aa`],
    ['a non-ASCII name', 'dwsì.internal'],
    ['localhost', 'localhost'],
    ['a name under localhost', 'db.localhost'],
    ['a single label', 'dwsi'],
    ['an all-numeric name', '10.0.0'],
    ['blank', ' '],
  ])('refuse %s', (_label, host) => {
    expect(refusal([entry(host)])).toBe('private_host_invalid')
  })

  it('refuse a TLS mode they do not know', () => {
    expect(refusal([entry('dwsi.internal', { databaseTls: 'disable' })])).toBe(
      'private_host_invalid',
    )
  })

  it('refuse a certificate authority that is not one PEM certificate', () => {
    expect(refusal([entry('dwsi.internal', { caPem: 'not a certificate' })])).toBe(
      'private_host_invalid',
    )
    expect(refusal([entry('dwsi.internal', { caPem: `${CA}x`.repeat(1000) })])).toBe(
      'private_host_invalid',
    )
  })

  it('refuse a certificate authority without verification', () => {
    expect(refusal([entry('dwsi.internal', { databaseTls: 'unverified', caPem: CA })])).toBe(
      'private_host_invalid',
    )
  })

  it('refuse the same host twice', () => {
    expect(refusal([entry('dwsi.internal'), entry('DWSI.internal')])).toBe('private_host_duplicate')
  })

  it(`hold at most ${MAX_PRIVATE_HOSTS} hosts`, () => {
    const many = Array.from({ length: MAX_PRIVATE_HOSTS + 1 }, (_, i) => entry(`h${i}.internal`))
    expect(refusal(many)).toBe('private_hosts_too_many')
    expect(parsePrivateHosts(many.slice(1))).toHaveLength(MAX_PRIVATE_HOSTS)
  })

  it.each([
    ['not a list', { host: 'dwsi.internal' }],
    ['an entry that is not an object', ['dwsi.internal']],
    ['an entry without host', [{ databaseTls: 'verify_full' }]],
    ['an entry with an unknown field', [entry('dwsi.internal', { port: 5432 })]],
  ])('refuse %s', (_label, raw) => {
    expect(refusal(raw)).toBe('private_host_invalid')
  })
})

describe('the certificate authority the Admin pastes for a host', () => {
  const chain = TEST_ISSUING_CA + TEST_ROOT_CA

  function caRefusal(raw: unknown): string {
    try {
      readCaPem(raw)
    } catch (error) {
      if (error instanceof DomainError) return error.code
      throw error
    }
    throw new Error('accepted')
  }

  it('is one certificate, kept with plain line ends and a final one', () => {
    const pasted = `  ${TEST_ROOT_CA.trim().replaceAll('\n', '  \r\n')}  \r\n`
    expect(readCaPem(pasted)).toBe(TEST_ROOT_CA)
  })

  it('may be a chain of certificates, blank lines between them dropped', () => {
    expect(readCaPem(`${TEST_ISSUING_CA}\n\n${TEST_ROOT_CA}`)).toBe(chain)
    expect(parsePrivateHosts([entry('dwsi.internal', { caPem: chain })])[0]?.caPem).toBe(chain)
  })

  it(`holds at most ${MAX_CA_CERTIFICATES} certificates`, () => {
    const many = TEST_ROOT_CA.repeat(MAX_CA_CERTIFICATES + 1)
    expect(caRefusal(many)).toBe('private_host_ca_too_long')
    expect(readCaPem(TEST_ROOT_CA.repeat(MAX_CA_CERTIFICATES))).toHaveLength(
      TEST_ROOT_CA.length * MAX_CA_CERTIFICATES,
    )
    expect(refusal([entry('dwsi.internal', { caPem: many })])).toBe('private_host_invalid')
  })

  it('is refused too long', () => {
    expect(caRefusal(`${TEST_ROOT_CA}\n`.repeat(30))).toBe('private_host_ca_too_long')
  })

  it.each([
    ['empty', '  '],
    ['not text', 42],
    ['not a certificate at all', 'hello'],
    ['a private key', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n'],
    ['text around the certificate', `subject=CN=x\n${TEST_ROOT_CA}`],
    ['a block whose content is no certificate', CA],
    ['a block cut short', TEST_ROOT_CA.slice(0, 200)],
  ])('is refused when %s', (_label, raw) => {
    expect(caRefusal(raw)).toBe('private_host_ca_invalid')
  })

  it('is described by the fingerprint and the names of each certificate, never its text', () => {
    expect(describeCaPem(chain)).toEqual([
      {
        fingerprint: TEST_ISSUING_CA_FINGERPRINT,
        subject: 'Octobrief Test Issuing CA',
        issuer: 'Octobrief Test Root CA',
      },
      {
        fingerprint: TEST_ROOT_CA_FINGERPRINT,
        subject: 'Octobrief Test Root CA',
        issuer: 'Octobrief Test Root CA',
      },
    ])
  })

  it('is set, replaced or removed on one host of the list, the others untouched', () => {
    const list = parsePrivateHosts([
      entry('dwsi.internal'),
      entry('tracker.internal', { databaseTls: 'plaintext' }),
    ])
    const set = withHostCa(list, 'DWSI.internal', TEST_ROOT_CA)
    expect(set).toEqual([{ ...list[0], caPem: TEST_ROOT_CA }, list[1]])
    expect(withHostCa(set, 'dwsi.internal', chain)[0]?.caPem).toBe(chain)
    expect(withHostCa(set, 'dwsi.internal', null)).toEqual(list)
  })

  it('is refused on a host whose certificate is not checked, or not on the list', () => {
    const list = parsePrivateHosts([entry('tracker.internal', { databaseTls: 'unverified' })])
    const code = (f: () => unknown) => {
      try {
        f()
      } catch (error) {
        if (error instanceof DomainError) return error.code
        throw error
      }
      throw new Error('accepted')
    }
    expect(code(() => withHostCa(list, 'tracker.internal', TEST_ROOT_CA))).toBe(
      'private_host_ca_not_verified',
    )
    expect(code(() => withHostCa(list, 'other.internal', TEST_ROOT_CA))).toBe(
      'private_host_unknown',
    )
  })

  it('still gives the fingerprint of a stored block it cannot read as a certificate', () => {
    const [only] = describeCaPem(CA)
    expect(only?.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(only?.subject).toBeNull()
    expect(only?.issuer).toBeNull()
  })
})
