import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delivery } from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import {
  createIngestClient,
  FeederError,
  type Outcome,
  type Provider,
  runFeeder,
} from '../src/feeder.ts'
import {
  commandProvider,
  deliveryOf,
  firstJsonObject,
  m365Prompt,
  m365Provider,
} from '../src/providers/command.ts'
import { dwsiProvider } from '../src/providers/dwsi.ts'
import { fileProvider } from '../src/providers/file.ts'
import { folderProvider } from '../src/providers/folder.ts'
import { inCalls, toWire, type WireDelivery } from '../src/wire.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'octobrief-feeder-'))
const all = async (provider: Provider) => {
  const deliveries: WireDelivery[] = []
  for await (const delivery of provider.deliveries()) deliveries.push(delivery)
  return deliveries
}
const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  duplicates: 0,
  records: 0,
  rows: 0,
  removed: 0,
  ...over,
})
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof FeederError ? error.code : 'unexpected'),
  )

describe('wire format', () => {
  const delivery: Delivery = {
    dataAsOf: new Date('2026-11-12T08:00:00Z'),
    documents: [
      {
        externalId: 'a',
        version: '1',
        title: 'Nota',
        mediaType: 'text/markdown',
        bytes: new TextEncoder().encode('ciao'),
        originAt: new Date('2026-11-10T08:00:00Z'),
        url: null,
        systemKind: 'generic',
        people: [{ displayName: 'Mario Rossi' }],
      },
      {
        externalId: 'b',
        version: '1',
        title: 'piano.pdf',
        mediaType: 'application/pdf',
        bytes: new Uint8Array([0xff, 0xfe]),
        originAt: null,
        url: 'https://example.test/b',
        people: [],
      },
      {
        externalId: 'c',
        version: '1',
        title: 'rotto.txt',
        mediaType: 'text/plain',
        bytes: new Uint8Array([0xff]),
        originAt: null,
        url: null,
        people: [],
      },
    ],
    records: [
      {
        externalId: 'r',
        version: '2',
        title: 'Storia',
        record: { s: 1 },
        originAt: null,
        url: null,
        people: [],
      },
    ],
    rows: [
      {
        view: 'v',
        perimeter: 'p',
        rows: [{ key: 'k', values: { a: 1 } }],
        extractedAt: new Date('2026-11-12T08:00:00Z'),
        sourceSyncedAt: null,
      },
    ],
    removed: ['x'],
  }

  it('sends text as text and anything else as base64, dates as ISO strings', () => {
    const wire = toWire(delivery)
    expect(wire.dataAsOf).toBe('2026-11-12T08:00:00.000Z')
    expect(wire.documents?.[0]).toMatchObject({
      text: 'ciao',
      kind: 'generic',
      originAt: '2026-11-10T08:00:00.000Z',
      people: [{ displayName: 'Mario Rossi' }],
    })
    expect(wire.documents?.[1]).toMatchObject({ contentBase64: '//4=', originAt: null })
    expect(wire.documents?.[2]).toMatchObject({ contentBase64: '/w==' })
    expect(wire.records?.[0]).toMatchObject({ externalId: 'r', record: { s: 1 } })
    expect(wire.rows?.[0]).toMatchObject({
      extractedAt: '2026-11-12T08:00:00.000Z',
      sourceSyncedAt: null,
    })
    expect(wire.removed).toEqual(['x'])
  })

  it('splits a delivery in calls; rows, removals and freshness travel with the last', () => {
    const calls = inCalls(toWire(delivery), 2)
    expect(calls.map((call) => [call.documents?.length ?? 0, call.records?.length ?? 0])).toEqual([
      [2, 0],
      [1, 0],
      [0, 1],
    ])
    expect(calls[0]?.rows).toBeUndefined()
    expect(calls[2]).toMatchObject({ removed: ['x'], dataAsOf: '2026-11-12T08:00:00.000Z' })
    expect(calls[2]?.rows).toHaveLength(1)
    expect(inCalls({}, 2)).toEqual([{}])
  })
})

describe('ingest client and run', () => {
  it('posts each call with the bearer token and adds up what was stored', async () => {
    const seen: Array<{ url: string; authorization: string; body: WireDelivery }> = []
    const send = createIngestClient({
      server: 'https://octobrief.example.test/ignored',
      sourceId: 'source-1',
      token: 'obf_secret',
      fetch: (async (url: URL, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        seen.push({
          url: String(url),
          authorization: headers.authorization as string,
          body: JSON.parse(init.body as string),
        })
        return Response.json(outcome({ created: 1 }))
      }) as unknown as typeof fetch,
    })
    const provider: Provider = {
      name: 'test',
      async *deliveries() {
        yield {
          documents: Array.from({ length: 101 }, (_, i) => ({ externalId: `d${i}` }) as never),
        }
        yield { dataAsOf: '2026-11-12T08:00:00.000Z' }
      },
    }
    const lines: string[] = []
    const total = await runFeeder(provider, send, (line) => lines.push(line))
    expect(total).toMatchObject({ created: 3 })
    expect(seen.map((call) => call.body.documents?.length ?? 0)).toEqual([100, 1, 0])
    expect(seen[0]).toMatchObject({
      url: 'https://octobrief.example.test/api/ingest/source-1',
      authorization: 'Bearer obf_secret',
    })
    expect(lines).toEqual([
      'test: 3 nuovi, 0 aggiornati, 0 invariati, 0 duplicati, 0 record, 0 righe',
    ])
    expect(lines.join()).not.toContain('obf_secret')
  })

  it('turns failures into codes, never echoing the token', async () => {
    const client = (respond: () => Response | Promise<Response>) =>
      createIngestClient({
        server: 'http://127.0.0.1:1',
        sourceId: 's',
        token: 'obf_secret',
        fetch: (async () => respond()) as unknown as typeof fetch,
      })
    expect(await codeOf(client(() => new Response('', { status: 401 }))({}))).toBe('unauthorized')
    expect(await codeOf(client(() => new Response('', { status: 413 }))({}))).toBe('refused_413')
    const unreachable = client(() => {
      throw new TypeError('fetch failed')
    })({})
    expect(await codeOf(unreachable)).toBe('server_unreachable')
    await expect(unreachable).rejects.not.toThrow(/obf_secret/)
  })
})

describe('providers', () => {
  it('reads a delivery, or several, from a JSON file', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'one.json'), JSON.stringify({ documents: [{ externalId: 'a' }] }))
    writeFileSync(join(dir, 'many.json'), JSON.stringify([{ documents: [] }, { removed: ['x'] }]))
    writeFileSync(join(dir, 'bad.json'), '{"documents": "no"}')
    writeFileSync(join(dir, 'broken.json'), '{')
    expect(await all(fileProvider(join(dir, 'one.json')))).toHaveLength(1)
    expect(await all(fileProvider(join(dir, 'many.json')))).toHaveLength(2)
    for (const name of ['bad.json', 'broken.json', 'missing.json']) {
      expect(await codeOf(all(fileProvider(join(dir, name))))).toBe('provider_failed')
    }
  })

  it('reads the readable files of a folder, never hidden ones, links or unknown kinds', async () => {
    const root = temp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'nota.txt'), 'una nota')
    writeFileSync(join(root, 'sub', 'SAL.md'), '# SAL')
    writeFileSync(join(root, 'vuoto.txt'), '')
    writeFileSync(join(root, 'programma.exe'), 'x')
    writeFileSync(join(root, '.segreto.txt'), 'x')
    symlinkSync(join(root, 'nota.txt'), join(root, 'link.txt'))
    const deliveries = await all(folderProvider(root))
    const documents = deliveries.flatMap((delivery) => delivery.documents ?? [])
    expect(documents.map((d) => [d.externalId, d.title, d.mediaType])).toEqual([
      ['nota.txt', 'nota.txt', 'text/plain'],
      ['sub/SAL.md', 'SAL.md', 'text/markdown'],
    ])
    expect(Buffer.from(documents[0]?.contentBase64 as string, 'base64').toString()).toBe('una nota')
    expect(documents[0]?.version).toMatch(/^8-\d+$/)
    expect(deliveries.at(-1)?.dataAsOf).toEqual(expect.any(String))
  })

  it('delivers in several steps a folder with many files', async () => {
    const root = temp()
    for (let i = 0; i < 23; i++)
      writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), `n${i}`)
    const deliveries = await all(folderProvider(root))
    expect(deliveries.map((delivery) => delivery.documents?.length)).toEqual([10, 10, 3])
  })

  it('finds the delivery a command prints, also wrapped by Claude in a result', () => {
    expect(firstJsonObject('prima {"a": {"b": 1}} dopo }')).toEqual({ a: { b: 1 } })
    expect(firstJsonObject('niente')).toBeNull()
    expect(deliveryOf('```json\n{"documents":[{"externalId":"m"}]}\n```').documents).toHaveLength(1)
    const wrapped = JSON.stringify({ type: 'result', result: 'Ecco: {"documents":[]}' })
    expect(deliveryOf(wrapped)).toEqual({ documents: [] })
    expect(() => deliveryOf('{"result":"nessun elemento"}')).toThrow(FeederError)
    expect(() => deliveryOf('{"documents":"no"}')).toThrow(FeederError)
  })

  it('runs a program and delivers what it prints; a failing one is a provider failure', async () => {
    const dir = temp()
    const script = join(dir, 'fake-claude.sh')
    writeFileSync(
      script,
      '#!/bin/sh\n[ "$1" = "-p" ] || exit 3\nprintf \'{"result":"{\\\\"documents\\\\":[{\\\\"externalId\\\\":\\\\"mail-1\\\\"}]}"}\'\n',
    )
    chmodSync(script, 0o755)
    const [delivery] = await all(m365Provider({ query: 'Borea', days: 7, claude: script }))
    expect(delivery?.documents).toEqual([{ externalId: 'mail-1' }])
    expect(m365Prompt('Borea', 7)).toContain('ultimi 7 giorni che riguardano: Borea')
    expect(m365Prompt('Borea', 7)).toContain('SOLO strumenti di lettura')
    const failing = commandProvider({ name: 'x', command: script, args: ['--nope'] })
    expect(await codeOf(all(failing))).toBe('provider_failed')
  })

  it('reports a warehouse that cannot be read as a provider failure, with its code', async () => {
    const options = {
      host: 'dwsi.example.test',
      port: 5432,
      database: 'dwsi',
      user: 'reader',
      password: 'pw',
      projectCodes: ['PRJ000001'],
      ownerEmail: 'paola@example.test',
      tls: 'plaintext' as const,
    }
    const bad = all(dwsiProvider({ ...options, projectCodes: ['nope'] }))
    await expect(bad).rejects.toThrow('warehouse: source_not_configured')
    // A host that does not resolve is refused before any connection.
    const unreachable = all(dwsiProvider({ ...options, host: 'no-such-host.invalid' }))
    expect(await codeOf(unreachable)).toBe('provider_failed')
  })
})
