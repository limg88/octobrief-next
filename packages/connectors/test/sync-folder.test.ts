import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderSyncFile, type SyncFile } from '../src/folder/sync-file.ts'
import { listFolder, readFolderBatch } from '../src/folder/sync-folder.ts'

const item = (id: string) => ({
  externalId: id,
  version: 'v1',
  title: `Attività ${id}`,
  originAt: new Date('2026-11-10T09:00:00Z'),
  url: null,
  people: [{ displayName: 'Carla Cliente', untrusted: true }],
})
const record = (id: string): SyncFile => ({
  system: 'jira',
  type: 'record',
  body: `# ${id}\n`,
  record: { ...item(id), record: { type: 'Bug' } },
})
const mail = (id: string, body = 'Testo della mail.\n', systemKind = 'transcript'): SyncFile => ({
  system: 'm365',
  type: 'document',
  systemKind,
  body,
  ...item(id),
})
const view = (perimeter: string, count: number): SyncFile => ({
  system: 'dwsi',
  type: 'rows',
  body: '',
  rows: {
    view: 'invoices',
    perimeter,
    rows: Array.from({ length: count }, (_, i) => ({ key: `r${i}`, values: { n: i } })),
    extractedAt: new Date('2026-11-12T08:00:00Z'),
    sourceSyncedAt: null,
  },
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octobrief-sync-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function put(path: string, content: string | SyncFile) {
  const full = join(root, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, typeof content === 'string' ? content : renderSyncFile(content))
}

describe('a synchronized folder', () => {
  it('lists readable files in a stable order, without hidden ones, links or unknown types', async () => {
    await put('jira/BOR-2.md', record('BOR-2'))
    await put('jira/BOR-1.md', record('BOR-1'))
    await put('jira/.bozza.md', 'nascosto')
    await put('.octobrief-sync/state.json', '{}')
    await put('jira/foto.png', 'x')
    await symlink(join(root, 'jira'), join(root, 'collegamento'))
    expect(await listFolder(root)).toEqual(['jira/BOR-1.md', 'jira/BOR-2.md'])
  })

  it('reads each file as what its header says, and the rest as plain documents', async () => {
    await put('jira/BOR-1.md', record('BOR-1'))
    await put('jira/nota.txt', 'Una nota a mano.')
    await put('jira/appunti.md', '# Appunti senza intestazione\n')
    await put('jira/altro-sistema.md', mail('m-1'))
    await put('jira/vuoto.md', '')
    await put('.octobrief-sync/removed.json', JSON.stringify({ jira: ['BOR-9', 7], ado: ['1'] }))
    await put(
      '.octobrief-sync/state.json',
      JSON.stringify({ jira: { dataAsOf: '2026-11-12T08:00:00Z' } }),
    )
    const batch = await readFolderBatch({
      dir: join(root, 'jira'),
      sync: { root, system: 'jira' },
      offset: 0,
    })
    expect(batch.records.map((r) => r.externalId)).toEqual(['BOR-1'])
    expect(batch.documents.map((d) => [d.externalId, d.mediaType])).toEqual([
      ['appunti.md', 'text/markdown'],
      ['nota.txt', 'text/plain'],
    ])
    expect(batch.documents[1]?.fileModifiedAt).toBeInstanceOf(Date)
    expect(batch).toMatchObject({
      removed: ['BOR-9'],
      dataAsOf: new Date('2026-11-12T08:00:00Z'),
      nextOffset: null,
    })
  })

  it('turns a document file into its text with its metadata', async () => {
    await put('m365/mail/uno.md', mail('m-1'))
    await put('m365/mail/senza-testo.md', mail('m-2', ' \n'))
    await put('m365/mail/tipo-ignoto.md', mail('m-3', 'Testo.\n', 'email'))
    const batch = await readFolderBatch({
      dir: join(root, 'm365'),
      sync: { root, system: 'm365' },
      offset: 0,
    })
    expect(batch.documents.map((d) => [d.externalId, d.systemKind])).toEqual([
      ['m-3', undefined],
      ['m-1', 'transcript'],
    ])
    expect(batch.documents[1]).toMatchObject({
      externalId: 'm-1',
      title: 'Attività m-1',
      systemKind: 'transcript',
      people: [{ displayName: 'Carla Cliente', untrusted: true }],
    })
    expect(new TextDecoder().decode(batch.documents[1]?.bytes)).toBe('Testo della mail.\n')
    // No state yet: nothing is gone, the freshness is not known.
    expect(batch).toMatchObject({ removed: [], dataAsOf: null })
  })

  it('reads a large folder in batches and closes only with the last one', async () => {
    for (const n of [1, 2, 3]) await put(`jira/BOR-${n}.md`, record(`BOR-${n}`))
    await put('.octobrief-sync/removed.json', JSON.stringify({ jira: ['BOR-9'] }))
    const options = { dir: join(root, 'jira'), sync: { root, system: 'jira' as const }, limit: 2 }
    const first = await readFolderBatch({ ...options, offset: 0 })
    expect(first).toMatchObject({ nextOffset: 2, removed: [], dataAsOf: null })
    expect(first.records).toHaveLength(2)
    const second = await readFolderBatch({ ...options, offset: 2 })
    expect(second).toMatchObject({ nextOffset: null, removed: ['BOR-9'] })
    expect(second.records.map((r) => r.externalId)).toEqual(['BOR-3'])
  })

  it('keeps the rows of one delivery under the limit', async () => {
    await put('netsuite/a.md', view('PRJ1', 15_000))
    await put('netsuite/b.md', view('PRJ2', 15_000))
    await put('netsuite/c.md', view('PRJ3', 20_001))
    const options = { dir: join(root, 'netsuite'), sync: { root, system: 'dwsi' as const } }
    const first = await readFolderBatch({ ...options, offset: 0 })
    expect(first.rows.map((r) => r.perimeter)).toEqual(['PRJ1'])
    expect(first.nextOffset).toBe(1)
    const second = await readFolderBatch({ ...options, offset: 1 })
    // The view too large for any delivery is left out.
    expect(second.rows.map((r) => r.perimeter)).toEqual(['PRJ2'])
    expect(second.nextOffset).toBeNull()
  })

  it('reads a plain folder as documents, fresh as of now, whatever a state file says', async () => {
    await put('SAL.md', '# SAL\n')
    await put('.octobrief-sync/state.json', 'non è JSON')
    const batch = await readFolderBatch({ dir: root, offset: 0 })
    expect(batch.documents.map((d) => d.externalId)).toEqual(['SAL.md'])
    expect(batch.dataAsOf).toBeInstanceOf(Date)
    expect(batch.removed).toEqual([])
  })
})
