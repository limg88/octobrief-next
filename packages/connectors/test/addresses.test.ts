import { describe, expect, it } from 'vitest'
import { addressAllowed, classifyAddress } from '../src/addresses.ts'

describe('the addresses a connector may reach', () => {
  it('are public ones', () => {
    for (const a of [
      '93.184.216.34',
      '13.107.42.16',
      '2606:4700::1111',
      '172.32.0.1',
      '100.128.0.1',
    ]) {
      expect(classifyAddress(a)).toBe('public')
    }
  })

  it('tell loopback apart, in every spelling', () => {
    for (const a of [
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(classifyAddress(a)).toBe('loopback')
    }
  })

  it('tell private ones apart: reachable only for a host the Admin allows', () => {
    for (const a of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ]) {
      expect(classifyAddress(a), a).toBe('private')
    }
  })

  it('refuse shared, link-local, metadata, multicast, unspecified and tunnelled ones', () => {
    for (const a of [
      '169.254.169.254',
      '169.254.0.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      'fe80::1',
      'fe80::1%en0',
      'ff02::1',
      '::ffff:169.254.169.254',
      '64:ff9b::a00:1',
      '::ffff:0:a00:1',
      '::ffff:0:7f00:1',
      '2002:7f00:1::1',
      '2002:a00:1::',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      'fec0::1',
      'feff:ffff::1',
      'fd00:ec2::254',
      'not-an-address',
    ]) {
      expect(classifyAddress(a), a).toBe('forbidden')
    }
  })

  it('accept a private address only for an allowed private host, never loopback or forbidden', () => {
    const vet = (address: string, privateHost: boolean, allowLoopback = false) =>
      addressAllowed(classifyAddress(address), { privateHost, allowLoopback })
    expect(vet('93.184.216.34', false)).toBe(true)
    expect(vet('10.0.0.5', false)).toBe(false)
    expect(vet('10.0.0.5', true)).toBe(true)
    expect(vet('fd12:3456::1', true)).toBe(true)
    expect(vet('169.254.169.254', true)).toBe(false)
    expect(vet('fe80::1', true)).toBe(false)
    expect(vet('fd00:ec2::254', true)).toBe(false)
    expect(vet('fec0::1', false)).toBe(false)
    expect(vet('127.0.0.1', true)).toBe(false)
    expect(vet('127.0.0.1', false, true)).toBe(true)
  })
})
