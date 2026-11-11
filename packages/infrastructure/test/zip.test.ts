import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { listZipEntries, ZipUnreadable } from '../src/extract/zip.ts'

const END_OF_DIRECTORY = 0x06054b50

function archive(): Uint8Array {
  return zipSync({
    'word/document.xml': strToU8('<a/>'),
    'word/header1.xml': strToU8('<b/>'),
  })
}

function endOf(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) return at
  }
  throw new Error('no end record')
}

function edited(edit: (view: DataView, end: number) => void): Uint8Array {
  const bytes = archive().slice()
  edit(new DataView(bytes.buffer), endOf(bytes))
  return bytes
}

describe('zip central directory', () => {
  it('lists the entries of a well-formed archive', () => {
    expect(listZipEntries(archive()).map((e) => e.name)).toEqual([
      'word/document.xml',
      'word/header1.xml',
    ])
  })

  it('refuses an archive whose end record counts fewer entries than its directory holds', () => {
    const bytes = edited((view, end) => {
      view.setUint16(end + 8, 1, true)
      view.setUint16(end + 10, 1, true)
    })
    expect(() => listZipEntries(bytes)).toThrow(ZipUnreadable)
  })

  it('refuses a directory that does not end where the end record begins', () => {
    const bytes = edited((view, end) => {
      view.setUint32(end + 12, view.getUint32(end + 12, true) - 1, true)
    })
    expect(() => listZipEntries(bytes)).toThrow(ZipUnreadable)
  })

  it('refuses an archive split over disks', () => {
    const bytes = edited((view, end) => view.setUint16(end + 4, 1, true))
    expect(() => listZipEntries(bytes)).toThrow(ZipUnreadable)
  })

  it('refuses data after the end record that is not its comment', () => {
    const bytes = archive()
    const longer = new Uint8Array(bytes.length + 4)
    longer.set(bytes)
    expect(() => listZipEntries(longer)).toThrow(ZipUnreadable)
  })
})
