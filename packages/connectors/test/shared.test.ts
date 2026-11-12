import { describe, expect, it } from 'vitest'
import { ConnectorError } from '../src/errors.ts'
import { backlogExport, csvDocument, exportTitle } from '../src/shared/export.ts'
import { orderGuard } from '../src/shared/order.ts'
import { cutToCharacters, headOf, tidyLines } from '../src/shared/text.ts'

const failure = (run: () => void) => {
  try {
    run()
  } catch (error) {
    return error instanceof ConnectorError ? error.code : 'other'
  }
  return null
}

describe('the order an answer must come in', () => {
  it('fails on an item before the previous one, and on an equal one when strict', () => {
    const strict = orderGuard<number>((a, b) => a - b, { strict: true })
    strict(1)
    strict(2)
    expect(failure(() => strict(2))).toBe('source_bad_response')
    const loose = orderGuard<number>((a, b) => a - b, { strict: false })
    loose(1)
    loose(1)
    expect(failure(() => loose(0))).toBe('source_bad_response')
  })
})

describe('the text helpers', () => {
  it('cap the input without half a character', () => {
    expect(headOf('abc', 5)).toBe('abc')
    expect(headOf('ab😀', 3)).toBe('ab')
    expect(cutToCharacters('a😀b', 2)).toBe('a😀')
  })

  it('fold spaces and empty lines', () => {
    expect(tidyLines('  a   b \n\n\n c ')).toBe('a b\n\nc')
  })
})

describe('the backlog export', () => {
  it('neutralizes formulas in every cell, the header too', () => {
    const csv = new TextDecoder().decode(csvDocument(['=H'], [['@x'], [-1]]))
    expect(csv).toBe("'=H\r\n'@x\r\n-1\r\n")
  })

  it('is backlog evidence with the perimeter and people of its records', () => {
    const record = {
      externalId: '1',
      version: '1',
      title: 't',
      mediaType: 'application/json',
      record: {},
      originAt: null,
      author: null,
      url: null,
      people: [{ displayName: 'A' }, { displayName: 'A' }],
    }
    const item = backlogExport({
      position: 'p',
      title: exportTitle('Jira', new Date('2026-11-05T09:30:00Z')),
      csv: new Uint8Array(),
      asOf: new Date(0),
      records: [
        { ...record, perimeter: ['b'] },
        { ...record, perimeter: ['a', 'b'] },
      ],
    })
    expect(item).toMatchObject({
      externalId: 'export:p',
      title: 'Export Jira del 05/11 10:30',
      kind: 'backlog_export',
      perimeter: ['a', 'b'],
      people: [{ displayName: 'A' }],
    })
  })
})
