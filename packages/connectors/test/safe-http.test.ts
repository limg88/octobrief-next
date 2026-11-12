import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type BlockedCall,
  ConnectorError,
  createSafeHttp,
  type HttpRule,
  type SafeHttpOptions,
} from '../src/index.ts'
import { type FakeServer, json, startFakeServer } from './support/fake-server.ts'
import { assertRulesConfined } from './support/rules-contract.ts'

let server: FakeServer
let blocked: BlockedCall[]
let waits: number[]

beforeAll(async () => {
  server = await startFakeServer()
})
afterAll(async () => {
  await server.close()
})
beforeEach(() => {
  server.received.length = 0
  blocked = []
  waits = []
})

const lit = (...names: string[]) => names.map((literal) => ({ literal }))

function rules(): HttpRule[] {
  return [
    { method: 'GET', host: server.host, path: lit('contoso', '_apis', 'projects') },
    { method: 'POST', host: server.host, path: lit('contoso', '_apis', 'wit', 'wiql') },
  ]
}

function client(overrides: Partial<SafeHttpOptions> = {}) {
  return createSafeHttp({
    rules: rules(),
    onBlocked: async (call) => {
      blocked.push(call)
    },
    allowLoopbackHttp: true,
    sleep: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError)
    return (error as ConnectorError).code
  }
  throw new Error('expected a connector failure')
}

describe('the allowlist', () => {
  it('lets an allowlisted read through and returns the answer', async () => {
    server.route((_req, res) => json(res, 200, { value: [{ id: 1 }] }))
    const res = await client().request({
      method: 'GET',
      url: `${server.origin}/contoso/_apis/projects?api-version=7.1`,
    })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ value: [{ id: 1 }] })
    expect(server.received).toHaveLength(1)
  })

  it('allows a read that the API makes with POST only where the rule says so', async () => {
    server.route((_req, res) => json(res, 200, { workItems: [] }))
    const http = client()
    await http.request({
      method: 'POST',
      url: `${server.origin}/contoso/_apis/wit/wiql`,
      body: JSON.stringify({ query: 'SELECT [System.Id] FROM WorkItems' }),
    })
    expect(
      await codeOf(
        http.request({ method: 'POST', url: `${server.origin}/contoso/_apis/projects` }),
      ),
    ).toBe('call_blocked')
    expect(server.received).toHaveLength(1)
  })

  it('refuses a write before the network and audits it without query or body', async () => {
    const http = client()
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(
        await codeOf(
          http.request({
            method,
            url: `${server.origin}/contoso/_apis/wit/wiql?token=abc123secret`,
            body: '{"fields":{"System.State":"Closed"}}',
          }),
        ),
      ).toBe('call_blocked')
    }
    expect(server.received).toEqual([])
    expect(blocked).toEqual(
      ['PATCH', 'PUT', 'DELETE'].map((method) => ({
        reason: 'method_not_allowed',
        method,
        host: server.host,
        path: '/contoso/_apis/wit/wiql',
      })),
    )
    expect(JSON.stringify(blocked)).not.toMatch(/token|abc123secret|Closed/)
  })

  it('refuses another host, another path and an unknown scheme', async () => {
    const http = client()
    expect(
      await codeOf(
        http.request({ method: 'GET', url: 'http://127.0.0.2:1/contoso/_apis/projects' }),
      ),
    ).toBe('call_blocked')
    expect(
      await codeOf(http.request({ method: 'GET', url: `${server.origin}/contoso/_apis/other` })),
    ).toBe('call_blocked')
    expect(
      await codeOf(
        http.request({ method: 'GET', url: `${server.origin}/contoso/_apis/projects/../wit` }),
      ),
    ).toBe('call_blocked')
    expect(
      await codeOf(
        http.request({ method: 'GET', url: `ftp://${server.host}/contoso/_apis/projects` }),
      ),
    ).toBe('call_blocked')
    expect(blocked.map((b) => b.reason)).toEqual([
      'host_not_allowed',
      'path_not_allowed',
      'path_not_allowed',
      'scheme_not_allowed',
    ])
    expect(server.received).toEqual([])
  })

  it('refuses plain http unless on loopback in tests, and credentials in the URL', async () => {
    const strict = client({ allowLoopbackHttp: false })
    expect(
      await codeOf(
        strict.request({ method: 'GET', url: `${server.origin}/contoso/_apis/projects` }),
      ),
    ).toBe('call_blocked')
    const external = createSafeHttp({
      rules: [{ method: 'GET', host: 'dev.example.com', path: [{ literal: 'x' }] }],
      onBlocked: async (call) => {
        blocked.push(call)
      },
      allowLoopbackHttp: true,
    })
    expect(await codeOf(external.request({ method: 'GET', url: 'http://dev.example.com/x' }))).toBe(
      'call_blocked',
    )
    expect(
      await codeOf(
        client().request({
          method: 'GET',
          url: `http://user:pw@${server.host}/contoso/_apis/projects`,
        }),
      ),
    ).toBe('call_blocked')
    expect(blocked.map((b) => b.reason)).toEqual([
      'scheme_not_allowed',
      'scheme_not_allowed',
      'credentials_in_url',
    ])
    expect(JSON.stringify(blocked)).not.toMatch(/pw/)
  })

  it('never accepts a rule for a writing method, a pattern host or a loose path', () => {
    const bad: unknown[] = [
      { method: 'PATCH', host: 'h', path: lit('x') },
      { method: 'GET', host: 'dev.azure.com.', path: lit('x') },
      { method: 'GET', host: '.*', path: lit('x') },
      { method: 'GET', host: 'a|b.com', path: lit('x') },
      { method: 'GET', host: 'Dev.Azure.com', path: lit('x') },
      { method: 'GET', host: 'h', path: [] },
      { method: 'GET', host: 'h', path: /^\/x$/ },
      { method: 'GET', host: 'h', path: [{ literal: '' }] },
      { method: 'GET', host: 'h', path: [{ literal: '..' }] },
      { method: 'GET', host: 'h', path: [{ literal: 'a/b' }] },
      { method: 'GET', host: 'h', path: [{ literal: 'a\\b' }] },
      { method: 'GET', host: 'h', path: [{ literal: 'a?b' }] },
      // A rest only after two literal segments.
      { method: 'GET', host: 'h', path: ['segment', 'segment'], rest: true },
      { method: 'GET', host: 'h', path: lit('x'), rest: true },
    ]
    for (const rule of bad) {
      expect(() =>
        createSafeHttp({ rules: [rule as HttpRule], onBlocked: async () => undefined }),
      ).toThrow(TypeError)
    }
  })

  it('compares a literal segment exactly: metacharacters are just characters', async () => {
    server.route((_req, res) => json(res, 200, {}))
    const http = client({
      rules: [{ method: 'GET', host: server.host, path: lit('contoso', 'x|y', '.*') }],
    })
    await http.request({ method: 'GET', url: `${server.origin}/contoso/x%7Cy/.*` })
    for (const path of ['/contoso/x/a', '/contoso/y/.*', '/contoso/x%7Cy/other', '/']) {
      expect(await codeOf(http.request({ method: 'GET', url: `${server.origin}${path}` }))).toBe(
        'call_blocked',
      )
    }
    expect(server.received).toHaveLength(1)
  })

  it('a segment part matches one id, and a rest only follows two literals', async () => {
    server.route((_req, res) => json(res, 200, {}))
    const http = client({
      rules: [
        { method: 'GET', host: server.host, path: [...lit('contoso', 'items'), 'segment'] },
        { method: 'GET', host: server.host, path: lit('contoso', 'files'), rest: true },
      ],
    })
    await http.request({ method: 'GET', url: `${server.origin}/contoso/items/42` })
    await http.request({ method: 'GET', url: `${server.origin}/contoso/files/a/b/c.txt` })
    for (const path of [
      '/contoso/items/',
      '/contoso/items/42/more',
      '/contoso/items',
      '/contoso/other/a',
    ]) {
      expect(await codeOf(http.request({ method: 'GET', url: `${server.origin}${path}` }))).toBe(
        'call_blocked',
      )
    }
    expect(server.received).toHaveLength(2)
  })

  it('refuses encoded separators and dots in the path', async () => {
    const http = client({
      rules: [{ method: 'GET', host: server.host, path: [...lit('contoso', '_apis'), 'segment'] }],
    })
    for (const name of ['a%2Fb', 'a%2fb', 'a%5Cb', '%2E%2E', 'a%2eb']) {
      expect(
        await codeOf(
          http.request({ method: 'GET', url: `${server.origin}/contoso/_apis/${name}` }),
        ),
      ).toBe('call_blocked')
    }
    expect(blocked.every((b) => b.reason === 'path_not_allowed')).toBe(true)
    expect(server.received).toEqual([])
  })

  it('refuses a decomposed (NFD) name before the network and lets its composed form through', async () => {
    const http = client({
      rules: [{ method: 'GET', host: server.host, path: lit('contoso', 'Ünità', 'items') }],
    })
    server.route((_req, res) => json(res, 200, {}))
    expect(
      await codeOf(
        http.request({ method: 'GET', url: `${server.origin}/contoso/U%CC%88nit%C3%A0/items` }),
      ),
    ).toBe('call_blocked')
    expect(blocked.map((b) => b.reason)).toEqual(['path_not_allowed'])
    expect(server.received).toEqual([])
    const ok = await http.request({
      method: 'GET',
      url: `${server.origin}/contoso/${encodeURIComponent('Ünità'.normalize('NFC'))}/items`,
    })
    expect(ok.status).toBe(200)
  })

  it('keeps a configuration full of metacharacters confined (the connectors contract)', () => {
    assertRulesConfined(
      (config: { org: string; project: string }) => [
        { method: 'GET', host: 'dev.azure.com', path: lit(config.org, config.project, '_apis') },
        {
          method: 'POST',
          host: 'dev.azure.com',
          path: [...lit(config.org, config.project, '_apis', 'wit'), 'segment'],
        },
      ],
      (value) => ({ org: value, project: `p-${value}` }),
    )
  })
})

describe('the addresses', () => {
  const external = (resolve: SafeHttpOptions['resolve'], allowLoopbackHttp = false) =>
    createSafeHttp({
      rules: [
        { method: 'GET', host: 'tracker.example', path: [{ literal: 'x' }] },
        { method: 'GET', host: '10.1.2.3', path: [{ literal: 'x' }] },
        { method: 'GET', host: `localhost:${server.host.split(':')[1]}`, path: [{ literal: 'x' }] },
      ],
      onBlocked: async (call) => {
        blocked.push(call)
      },
      allowLoopbackHttp,
      ...(resolve ? { resolve } : {}),
    })

  it('refuses a name that resolves to a private or loopback address, before connecting', async () => {
    for (const address of [
      '10.0.0.5',
      '127.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      const http = external(async () => [{ address, family: address.includes(':') ? 6 : 4 }])
      expect(
        await codeOf(http.request({ method: 'GET', url: 'https://tracker.example/x?q=1' })),
      ).toBe('call_blocked')
    }
    expect(blocked).toHaveLength(9)
    expect(blocked.every((b) => b.reason === 'address_not_allowed')).toBe(true)
    expect(blocked[0]).toEqual({
      reason: 'address_not_allowed',
      method: 'GET',
      host: 'tracker.example',
      path: '/x',
    })
  })

  it('refuses when any of the addresses of a name is private', async () => {
    const http = external(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    expect(await codeOf(http.request({ method: 'GET', url: 'https://tracker.example/x' }))).toBe(
      'call_blocked',
    )
  })

  describe('of a private host the Admin allows', () => {
    const allowed = (address: string, privateHosts: string[] = ['TRACKER.example']) =>
      createSafeHttp({
        rules: [
          { method: 'GET', host: 'tracker.example', path: [{ literal: 'x' }] },
          { method: 'GET', host: '10.1.2.3', path: [{ literal: 'x' }] },
        ],
        onBlocked: async (call) => {
          blocked.push(call)
        },
        privateHosts,
        timeoutMs: 300,
        maxRetries: 0,
        resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      })

    it('may be on a private network: the call goes to the address it resolved to', async () => {
      // Nothing listens there: the call fails at the network, it is not refused before it.
      for (const address of ['10.255.255.1', 'fd00::1']) {
        const code = await codeOf(
          allowed(address).request({ method: 'GET', url: 'https://tracker.example/x' }),
        )
        expect(['source_timeout', 'source_unreachable']).toContain(code)
      }
      expect(blocked).toEqual([])
    })

    it('never resolves to loopback, link-local or the metadata address', async () => {
      for (const address of ['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '100.64.0.1']) {
        expect(
          await codeOf(
            allowed(address).request({ method: 'GET', url: 'https://tracker.example/x' }),
          ),
        ).toBe('call_blocked')
      }
      expect(blocked.map((b) => b.reason)).toEqual(Array(5).fill('address_not_allowed'))
    })

    it('is a host name: a listed private address is still refused', async () => {
      const http = allowed('10.1.2.3', ['10.1.2.3'])
      expect(await codeOf(http.request({ method: 'GET', url: 'https://10.1.2.3/x' }))).toBe(
        'call_blocked',
      )
      expect(blocked.map((b) => b.reason)).toEqual(['address_not_allowed'])
    })

    it('does not open private addresses to the other hosts', async () => {
      const http = allowed('10.0.0.5', ['other.example'])
      expect(await codeOf(http.request({ method: 'GET', url: 'https://tracker.example/x' }))).toBe(
        'call_blocked',
      )
    })
  })

  it('refuses private literal hosts, and IPv6 literals have no rule', async () => {
    const http = external(undefined)
    expect(await codeOf(http.request({ method: 'GET', url: 'https://10.1.2.3/x' }))).toBe(
      'call_blocked',
    )
    expect(await codeOf(http.request({ method: 'GET', url: 'https://[::ffff:127.0.0.1]/x' }))).toBe(
      'call_blocked',
    )
    expect(blocked.map((b) => b.reason)).toEqual(['address_not_allowed', 'host_not_allowed'])
  })

  it('refuses localhost unless loopback is allowed for the tests', async () => {
    const url = `https://localhost:${server.host.split(':')[1]}/x`
    expect(await codeOf(external(undefined).request({ method: 'GET', url }))).toBe('call_blocked')
    expect(blocked.map((b) => b.reason)).toEqual(['address_not_allowed'])
  })

  it('connects only to the address it vetted (no second resolution)', async () => {
    let resolutions = 0
    server.route((_req, res) => json(res, 200, { ok: true }))
    const http = createSafeHttp({
      rules: [
        {
          method: 'GET',
          host: `rebind.example:${server.host.split(':')[1]}`,
          path: [{ literal: 'x' }],
        },
      ],
      onBlocked: async () => undefined,
      allowLoopbackHttp: true,
      resolve: async () => {
        resolutions += 1
        return [{ address: '127.0.0.1', family: 4 }]
      },
    })
    const res = await http
      .request({
        method: 'GET',
        url: `http://rebind.example:${server.host.split(':')[1]}/x`,
      })
      .catch((e: unknown) => e)
    // Plain http to a name is refused even in tests: only a loopback literal or localhost.
    expect((res as ConnectorError).code).toBe('call_blocked')

    const pinned = createSafeHttp({
      rules: [
        { method: 'GET', host: `localhost:${server.host.split(':')[1]}`, path: [{ literal: 'x' }] },
      ],
      onBlocked: async () => undefined,
      allowLoopbackHttp: true,
      resolve: async () => {
        resolutions += 1
        return [{ address: '127.0.0.1', family: 4 }]
      },
    })
    const ok = await pinned.request({
      method: 'GET',
      url: `http://localhost:${server.host.split(':')[1]}/x`,
    })
    expect(ok.json()).toEqual({ ok: true })
    expect(resolutions).toBe(1)
  })
})

describe('the answers', () => {
  it('never follows a redirect, and audits it', async () => {
    server.route((_req, res) => {
      res.writeHead(302, { location: 'https://evil.example/steal' }).end()
    })
    expect(
      await codeOf(
        client().request({ method: 'GET', url: `${server.origin}/contoso/_apis/projects` }),
      ),
    ).toBe('redirect_refused')
    expect(server.received).toHaveLength(1)
    expect(blocked).toEqual([
      expect.objectContaining({ reason: 'redirect_refused', path: '/contoso/_apis/projects' }),
    ])
  })

  it('stops reading an answer beyond the size cap', async () => {
    server.route((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(4096, 1))
    })
    expect(
      await codeOf(
        client({ maxResponseBytes: 1024 }).request({
          method: 'GET',
          url: `${server.origin}/contoso/_apis/projects`,
        }),
      ),
    ).toBe('response_too_large')
  })

  it('gives up on a slow answer at the timeout', async () => {
    server.route((_req, res) => {
      setTimeout(() => json(res, 200, {}), 1000)
    })
    expect(
      await codeOf(
        client({ timeoutMs: 100 }).request({
          method: 'GET',
          url: `${server.origin}/contoso/_apis/projects`,
        }),
      ),
    ).toBe('source_timeout')
  })

  it('respects 429 with Retry-After, then succeeds', async () => {
    let calls = 0
    server.route((_req, res) => {
      calls += 1
      if (calls === 1) json(res, 429, {}, { 'retry-after': '7' })
      else json(res, 200, { ok: true })
    })
    const res = await client().request({
      method: 'GET',
      url: `${server.origin}/contoso/_apis/projects`,
    })
    expect(res.json()).toEqual({ ok: true })
    expect(waits).toEqual([7000])
    expect(server.received).toHaveLength(2)
  })

  it('backs off on 503 without Retry-After, a bounded number of times', async () => {
    server.route((_req, res) => json(res, 503, {}))
    const error = await client({ maxRetries: 3 })
      .request({ method: 'GET', url: `${server.origin}/contoso/_apis/projects` })
      .catch((e: unknown) => e)
    expect((error as ConnectorError).code).toBe('source_unavailable')
    expect(waits).toEqual([1000, 2000, 4000])
    expect(server.received).toHaveLength(4)
  })

  it('does not wait longer than allowed: a long Retry-After is a rate-limit failure', async () => {
    server.route((_req, res) => json(res, 429, {}, { 'retry-after': '3600' }))
    const error = await client({ maxRetryWaitMs: 60_000 })
      .request({ method: 'GET', url: `${server.origin}/contoso/_apis/projects` })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectorError)
    expect((error as ConnectorError).code).toBe('source_rate_limited')
    expect((error as ConnectorError).detail.retryAfterMs).toBe(3_600_000)
    expect(waits).toEqual([])
  })

  it('maps an error status to a code that carries no URL', async () => {
    const statuses: Array<[number, string]> = [
      [401, 'source_auth_failed'],
      [403, 'source_forbidden'],
      [404, 'source_not_found'],
      [500, 'source_http_error'],
    ]
    for (const [status, code] of statuses) {
      server.route((_req, res) => json(res, status, { message: 'secret detail' }))
      const error = await client()
        .getJson(`${server.origin}/contoso/_apis/projects`)
        .catch((e: unknown) => e)
      expect((error as ConnectorError).code).toBe(code)
      expect(String(error)).not.toMatch(/127\.0\.0\.1|secret detail/)
    }
  })

  it('reports an unreadable JSON answer as a bad response', async () => {
    server.route((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{not json')
    })
    expect(await codeOf(client().getJson(`${server.origin}/contoso/_apis/projects`))).toBe(
      'source_bad_response',
    )
  })

  it('reports an unreachable source', async () => {
    const gone = await startFakeServer()
    await gone.close()
    const http = createSafeHttp({
      rules: [{ method: 'GET', host: gone.host, path: [{ literal: 'x' }] }],
      onBlocked: async () => undefined,
      allowLoopbackHttp: true,
    })
    expect(await codeOf(http.request({ method: 'GET', url: `${gone.origin}/x` }))).toBe(
      'source_unreachable',
    )
  })
})
