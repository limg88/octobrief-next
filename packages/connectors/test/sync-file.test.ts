import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseSyncFile, renderSyncFile, type SyncFile } from '../src/folder/sync-file.ts'

const record: SyncFile = {
  system: 'jira',
  type: 'record',
  body: '# BOR-12 — Il report non si apre\n\nDescrizione.\n',
  record: {
    externalId: 'BOR-12',
    version: '2026-11-10T09:00:00.000Z',
    title: 'Il report non si apre',
    originAt: new Date('2026-11-10T09:00:00Z'),
    url: 'https://jira.example.test/browse/BOR-12',
    people: [{ displayName: 'Carla Cliente', email: 'carla@cliente.example', untrusted: true }],
    record: { type: 'Bug', status: 'In Progress', points: 3 },
  },
}

const document: SyncFile = {
  system: 'm365',
  type: 'document',
  via: 'claude',
  externalId: 'mail-1',
  version: 'v1',
  title: 'RE: Budget',
  originAt: null,
  url: null,
  systemKind: 'email',
  mediaType: 'text/csv',
  people: [{ displayName: 'Paola Prova' }],
  body: 'Da: Paola Prova\n\n---\nIl budget resta di 890.000 euro.\n',
}

const rows: SyncFile = {
  system: 'dwsi',
  type: 'rows',
  body: '| Fattura | Importo |\n|---|---|\n| F-1 | 100 |\n',
  rows: {
    view: 'invoices',
    perimeter: 'PRJ000001',
    rows: [{ key: 'F-1', values: { amount: 100, paid: false, note: null } }],
    extractedAt: new Date('2026-11-12T08:00:00Z'),
    sourceSyncedAt: null,
  },
}

describe('sync file', () => {
  it('writes a header a person can read, one key per line', () => {
    const text = renderSyncFile(record)
    expect(text.split('\n').slice(0, 5)).toEqual([
      '---',
      'octobrief: 1',
      'system: "jira"',
      'type: "record"',
      'externalId: "BOR-12"',
    ])
    expect(text.endsWith('---\n# BOR-12 — Il report non si apre\n\nDescrizione.\n')).toBe(true)
  })

  it.each([
    ['record', record],
    ['document', document],
    ['rows', rows],
  ])('reads back a %s as it was written', (_name, file) => {
    expect(parseSyncFile(renderSyncFile(file))).toEqual(file)
  })

  it('reads back any text and any fields', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (body, title, fields) => {
          const file: SyncFile = {
            ...record,
            body,
            record: { ...record.record, title, record: JSON.parse(JSON.stringify(fields)) },
          }
          expect(parseSyncFile(renderSyncFile(file))).toEqual(file)
        },
      ),
    )
  })

  it.each([
    ['a plain text', 'Solo testo.\n'],
    ['a header that never ends', '---\noctobrief: 1\n'],
    ['another version', '---\noctobrief: 2\nsystem: "jira"\n---\n'],
    ['a line that is not a key', '---\noctobrief: 1\nsenza due punti\n---\n'],
    ['a value that is not JSON', '---\noctobrief: 1\nsystem: jira\n---\n'],
    ['an unknown system', renderSyncFile(record).replace('"jira"', '"altro"')],
    ['an unknown type', renderSyncFile(record).replace('"record"', '"altro"')],
    ['a record without fields', renderSyncFile(record).replace(/\nrecord: .*/, '')],
    ['an item without id', renderSyncFile(record).replace(/\nexternalId: .*/, '')],
    [
      'a date that is not one',
      renderSyncFile(record).replace(/\noriginAt: .*/, '\noriginAt: "ieri"'),
    ],
    ['a date of another shape', renderSyncFile(record).replace(/\noriginAt: .*/, '\noriginAt: 5')],
    ['an address that is not text', renderSyncFile(record).replace(/\nurl: .*/, '\nurl: 5')],
    ['people that are not a list', renderSyncFile(record).replace(/\npeople: .*/, '\npeople: {}')],
    ['a person without name', renderSyncFile(record).replace(/\npeople: .*/, '\npeople: [{}]')],
    ['rows without a view', renderSyncFile(rows).replace(/\nview: .*/, '')],
    ['rows that are not a list', renderSyncFile(rows).replace(/\nrows: .*/, '\nrows: 1')],
    ['a row without values', renderSyncFile(rows).replace(/\nrows: .*/, '\nrows: [{"key":"a"}]')],
  ])('does not take %s for a sync file', (_name, text) => {
    expect(parseSyncFile(text)).toBeNull()
  })

  it('accepts a header without people', () => {
    const text = renderSyncFile(document).replace(/\npeople: .*/, '')
    expect(parseSyncFile(text)).toMatchObject({ people: [], systemKind: 'email', via: 'claude' })
  })
})
