import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConnectorError, createSafeHttp } from '../src/index.ts'
import { json, startFakeServer } from './support/fake-server.ts'

let dir: string
const certs: Record<string, { key: string; cert: string }> = {}

/** A throwaway self-signed certificate for `name`, made now and never stored. */
function selfSigned(name: string): { key: string; cert: string } {
  const key = join(dir, `${name}.key`)
  const cert = join(dir, `${name}.crt`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

async function tlsServer(
  name: string,
): Promise<{ server: Server; port: number; servernames: string[] }> {
  const servernames: string[] = []
  const server = createServer(certs[name] as { key: string; cert: string }, (req, res) => {
    servernames.push((req.socket as TLSSocket).servername || '')
    json(res, 200, { ok: true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, servernames }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'octobrief-tls-'))
  certs['pinned.test'] = selfSigned('pinned.test')
  certs['other.test'] = selfSigned('other.test')
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const toLoopback = async () => [{ address: '127.0.0.1', family: 4 as const }]

describe('the transport of the safe client', () => {
  it('connects over https to the pinned address, with the host name as SNI', async () => {
    const { server, port, servernames } = await tlsServer('pinned.test')
    try {
      const http = createSafeHttp({
        rules: [{ method: 'GET', host: `pinned.test:${port}`, path: [{ literal: 'x' }] }],
        onBlocked: async () => undefined,
        allowLoopbackHttp: true,
        resolve: toLoopback,
        testTrustedCa: certs['pinned.test']?.cert as string,
      })
      expect(await http.getJson(`https://pinned.test:${port}/x`)).toEqual({ ok: true })
      expect(servernames).toEqual(['pinned.test'])
      http.close()
    } finally {
      server.close()
    }
  })

  it('refuses a pinned server whose certificate is for another name', async () => {
    const { server, port } = await tlsServer('other.test')
    try {
      const http = createSafeHttp({
        rules: [{ method: 'GET', host: `pinned.test:${port}`, path: [{ literal: 'x' }] }],
        onBlocked: async () => undefined,
        allowLoopbackHttp: true,
        resolve: toLoopback,
        // Even trusted, a certificate for another name is refused.
        testTrustedCa: `${certs['pinned.test']?.cert}${certs['other.test']?.cert}`,
      })
      const error = await http.getJson(`https://pinned.test:${port}/x`).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConnectorError)
      expect((error as ConnectorError).code).toBe('source_unreachable')
      http.close()
    } finally {
      server.close()
    }
  })

  it('never goes through a proxy set in the environment', async () => {
    const target = await startFakeServer((_req, res) => json(res, 200, { ok: true }))
    const proxy = await startFakeServer((_req, res) => json(res, 502, {}))
    const saved = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY }
    process.env.HTTP_PROXY = proxy.origin
    process.env.HTTPS_PROXY = proxy.origin
    try {
      const http = createSafeHttp({
        rules: [{ method: 'GET', host: target.host, path: [{ literal: 'x' }] }],
        onBlocked: async () => undefined,
        allowLoopbackHttp: true,
      })
      expect(await http.getJson(`${target.origin}/x`)).toEqual({ ok: true })
      expect(target.received).toHaveLength(1)
      expect(proxy.received).toEqual([])
      http.close()
    } finally {
      if (saved.http === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = saved.http
      if (saved.https === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = saved.https
      await Promise.all([target.close(), proxy.close()])
    }
  })

  it('a HEAD answer is not refused for the size it declares', async () => {
    const target = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) }).end()
    })
    try {
      const http = createSafeHttp({
        rules: [{ method: 'HEAD', host: target.host, path: [{ literal: 'x' }] }],
        onBlocked: async () => undefined,
        allowLoopbackHttp: true,
        maxResponseBytes: 1024,
      })
      const res = await http.request({ method: 'HEAD', url: `${target.origin}/x` })
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(0)
      http.close()
    } finally {
      await target.close()
    }
  })
})
