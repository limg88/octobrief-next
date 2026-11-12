import { describe, expect, it } from 'vitest'
import {
  type BlockedCall,
  ConnectorError,
  createNetGuard,
  type ResolvedAddress,
} from '../src/index.ts'

const DWSI = { host: 'dwsi.corp.example', databaseTls: 'verify_full' as const, caPem: null }

function guard(addresses: ResolvedAddress[] | Error, allowLoopback = false) {
  const blocked: BlockedCall[] = []
  const net = createNetGuard({
    privateHosts: [DWSI],
    onBlocked: async (call) => {
      blocked.push(call)
    },
    allowLoopback,
    resolve: async () => {
      if (addresses instanceof Error) throw addresses
      return addresses
    },
  })
  return { net, blocked }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError)
    return (error as ConnectorError).code
  }
  throw new Error('accepted')
}

describe('the network guard', () => {
  it('gives the vetted addresses and the Admin entry of a private host', async () => {
    const { net } = guard([{ address: '10.20.0.7', family: 4 }])
    expect(await net.vet('DWSI.corp.example', 5432, 'POSTGRES')).toEqual({
      addresses: [{ address: '10.20.0.7', family: 4 }],
      privateHost: DWSI,
    })
  })

  it('accepts a public host only when the Admin listed it', async () => {
    const { net } = guard([{ address: '93.184.216.34', family: 4 }])
    expect(await net.vet('dwsi.corp.example', 5432, 'POSTGRES')).toMatchObject({
      privateHost: DWSI,
    })
  })

  it('refuses and audits a host the Admin did not list, even a public one', async () => {
    const { net, blocked } = guard([{ address: '93.184.216.34', family: 4 }])
    expect(await codeOf(net.vet('pg.attacker.example', 5432, 'POSTGRES'))).toBe('call_blocked')
    expect(blocked).toEqual([
      {
        reason: 'host_not_allowed',
        method: 'POSTGRES',
        host: 'pg.attacker.example:5432',
        path: '',
      },
    ])
  })

  it('refuses an IP literal and audits it, before any resolution', async () => {
    for (const host of ['10.20.0.7', '[fd00::1]', '93.184.216.34']) {
      const { net, blocked } = guard(new Error('no resolution expected'))
      expect(await codeOf(net.vet(host, 5432, 'POSTGRES'))).toBe('call_blocked')
      expect(blocked).toHaveLength(1)
    }
  })

  it('refuses when any address is not allowed, loopback included outside the tests', async () => {
    const { net, blocked } = guard([
      { address: '10.20.0.7', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    expect(await codeOf(net.vet('dwsi.corp.example', 5432, 'POSTGRES'))).toBe('call_blocked')
    expect(blocked).toEqual([
      {
        reason: 'address_not_allowed',
        method: 'POSTGRES',
        host: 'dwsi.corp.example:5432',
        path: '',
      },
    ])
    const tests = guard([{ address: '127.0.0.1', family: 4 }], true)
    expect((await tests.net.vet('dwsi.corp.example', 5432, 'POSTGRES')).addresses).toHaveLength(1)
  })

  it('is unreachable when the name does not resolve', async () => {
    expect(
      await codeOf(guard(new Error('ENOTFOUND')).net.vet('dwsi.corp.example', 1, 'POSTGRES')),
    ).toBe('source_unreachable')
    expect(await codeOf(guard([]).net.vet('dwsi.corp.example', 1, 'POSTGRES'))).toBe(
      'source_unreachable',
    )
  })
})
