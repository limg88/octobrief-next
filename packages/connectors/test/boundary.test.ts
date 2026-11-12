import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '../../..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p)
    return /\.(c|m)?(t|j)sx?$/.test(p) ? [p] : []
  })
}

// Every way to the network a connector could take besides the safe client and the guard.
const NETWORK =
  /\bfetch\s*\(|['"]node:(?:http|https|net|tls|dgram|http2|dns|dns\/promises)['"]|['"](?:undici|axios|got|node-fetch|pg|postgres)['"]|\bXMLHttpRequest\b|\bWebSocket\b/

// The safe HTTP client, the network guard of the other connections, the address vetting both
// rely on, and the warehouse session (opened only to an address the guard vetted).
const SAFE_CLIENT = [
  'packages/connectors/src/safe-http.ts',
  'packages/connectors/src/addresses.ts',
  'packages/connectors/src/net-guard.ts',
  'packages/connectors/src/dwsi/session.ts',
]

describe('the way connectors reach the network', () => {
  it('is the safe HTTP client or the network guard only', () => {
    const dirs = [join(repoRoot, 'packages/connectors/src')]
    const offending = dirs
      .flatMap(walk)
      .map((f) => relative(repoRoot, f))
      .filter((f) => !SAFE_CLIENT.includes(f))
      .filter((f) => NETWORK.test(readFileSync(join(repoRoot, f), 'utf8')))
    expect(offending).toEqual([])
  })

  it('recognizes the ways around it', () => {
    expect(NETWORK.test('await fetch(url)')).toBe(true)
    expect(NETWORK.test(`import https from 'node:https'`)).toBe(true)
    expect(NETWORK.test(`import { request } from 'undici'`)).toBe(true)
    expect(NETWORK.test(`import pg from 'pg'`)).toBe(true)
    expect(NETWORK.test('ctx.http.getJson(url)')).toBe(false)
  })

  it('keeps fakes and test servers out of the production sources', () => {
    const offending = walk(join(repoRoot, 'packages/connectors/src')).filter((f) =>
      /\bfrom\s*['"][^'"]*(?:\btest\/|fake|test-support)/i.test(readFileSync(f, 'utf8')),
    )
    expect(offending).toEqual([])
  })
})
