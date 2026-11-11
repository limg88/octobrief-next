import { describe, expect, it } from 'vitest'
import { documentDate, isCertainDate, meetingDateInText, redated } from '../src/document-date.ts'
import { romeMidnight } from '../src/rome-time.ts'

const acquiredAt = new Date('2026-11-05T09:00:00Z')
const base = { metadataDate: null, acquiredAt, lang: 'it' as const }
const day = (y: number, m: number, d: number) => romeMidnight(y, m, d)

describe('documentDate', () => {
  it('the date given by the PM wins over everything', () => {
    const pmDate = day(2026, 1, 15)
    expect(
      documentDate({ ...base, pmDate, fileName: 'SAL_2026-10-31.docx', metadataDate: acquiredAt }),
    ).toEqual({ date: pmDate, source: 'pm' })
  })

  it('the date the source system gave comes after the PM and before the file name', () => {
    const systemDate = new Date('2024-11-05T09:00:00Z')
    expect(
      documentDate({
        ...base,
        systemDate,
        fileName: 'SAL_2026-10-31.docx',
        metadataDate: acquiredAt,
      }),
    ).toEqual({ date: systemDate, source: 'system' })
    const pmDate = day(2026, 1, 15)
    expect(documentDate({ ...base, pmDate, systemDate, fileName: 'x.txt' })).toEqual({
      date: pmDate,
      source: 'pm',
    })
  })

  it('an implausible system date is not used', () => {
    expect(
      documentDate({ ...base, systemDate: new Date('1970-01-01T00:00:00Z'), fileName: 'x.txt' }),
    ).toEqual({ date: acquiredAt, source: 'acquisition' })
  })

  it.each([
    ['SAL_2026-10-31.docx', day(2026, 10, 31)],
    ['SAL_2026_10_31.docx', day(2026, 10, 31)],
    ['verbale 3 novembre 2026.pdf', day(2026, 11, 3)],
    ['verbale_3_novembre_2026.pdf', day(2026, 11, 3)],
    ['verbale 3 nov 2026.pdf', day(2026, 11, 3)],
    ['verbale 1 Gennaio 2026.pdf', day(2026, 1, 1)],
    ['verbale 1° novembre 2026.pdf', day(2026, 11, 1)],
    ['verbale 1º novembre 2026.pdf', day(2026, 11, 1)],
    ['report 2026.11.03.pdf', day(2026, 11, 3)],
    ['report20261104.pdf', day(2026, 11, 4)],
    ['stato 03-11-2026.pdf', day(2026, 11, 3)],
    ['stato 03.11.2026.pdf', day(2026, 11, 3)],
    ['stato_03_11_2026.pdf', day(2026, 11, 3)],
  ])('reads the date from the file name %s', (fileName, date) => {
    expect(documentDate({ ...base, fileName })).toEqual({ date, source: 'file_name' })
  })

  it('reads day-first, never month-first', () => {
    expect(documentDate({ ...base, fileName: 'a 04-05-2026.pdf' }).date).toEqual(day(2026, 5, 4))
  })

  it('ignores a name date that is not a real calendar day', () => {
    expect(documentDate({ ...base, fileName: 'a_2026-02-30.pdf' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: 'a 31 aprile 2026.pdf' }).source).toBe('acquisition')
  })

  it('ignores a name date outside 1990 to the day after acquisition', () => {
    expect(documentDate({ ...base, fileName: 'a_1989-12-31.pdf' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: 'a_2026-11-07.pdf' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: 'a_2026-11-06.pdf' }).source).toBe('file_name')
    expect(documentDate({ ...base, fileName: 'a_19900101.pdf' }).source).toBe('file_name')
  })

  it('an order number that looks like a date is not taken when it is not plausible', () => {
    expect(documentDate({ ...base, fileName: 'ordine 99999999.pdf' }).source).toBe('acquisition')
  })

  it('two different dates in the name give no choice from the name', () => {
    const metadataDate = new Date('2026-10-01T10:00:00Z')
    expect(
      documentDate({ ...base, fileName: 'SAL 2026-10-31 vs 2026-09-30.pdf', metadataDate }),
    ).toEqual({ date: metadataDate, source: 'metadata' })
  })

  it('the same date written twice in the name is one date', () => {
    expect(documentDate({ ...base, fileName: '2026-10-31 (31 ottobre 2026).pdf' })).toEqual({
      date: day(2026, 10, 31),
      source: 'file_name',
    })
  })

  it('falls back to a plausible metadata date', () => {
    const metadataDate = new Date('2026-09-10T08:00:00Z')
    expect(documentDate({ ...base, fileName: 'notes.txt', metadataDate })).toEqual({
      date: metadataDate,
      source: 'metadata',
    })
  })

  it.each([
    new Date('1989-12-31T22:00:00Z'),
    new Date('2026-11-06T09:00:01Z'),
    new Date('invalid'),
  ])('ignores a metadata date out of range (%s)', (metadataDate) => {
    expect(documentDate({ ...base, fileName: 'notes.txt', metadataDate })).toEqual({
      date: acquiredAt,
      source: 'acquisition',
    })
  })

  it('declares the acquisition when nothing else is available', () => {
    expect(documentDate({ ...base, fileName: 'notes.txt' })).toEqual({
      date: acquiredAt,
      source: 'acquisition',
    })
  })

  it('a long file name with digits stays fast', () => {
    const fileName = `${'1-'.repeat(120)}x.pdf`
    expect(documentDate({ ...base, fileName }).source).toBe('acquisition')
  })

  it.each([
    ['3Giugno2026 - Riunione di prova.docx', day(2026, 6, 3)],
    ['25Settembre2026 - Avanzamento.docx', day(2026, 9, 25)],
    ['06Agosto2026 - Stato lavori.docx', day(2026, 8, 6)],
    ['4marzo2026 riunione.vtt', day(2026, 3, 4)],
    ['Kickoff 12June2026.docx', day(2026, 6, 12)],
    ['Kickoff 12 June 2026.docx', day(2026, 6, 12)],
    ['Kickoff_1-October-2026.docx', day(2026, 10, 1)],
  ])(
    'a meeting date written without separators in the file name dates the transcript (%s)',
    (fileName, date) => {
      expect(documentDate({ ...base, fileName })).toEqual({ date, source: 'file_name' })
    },
  )

  it('a month joined to the day and year counts only when written in full', () => {
    expect(documentDate({ ...base, fileName: '3giu2026.docx' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: 'v3abc2026.docx' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: 'x31Giugno2026.docx' }).source).toBe('acquisition')
    expect(documentDate({ ...base, fileName: '31Giugno2026.docx' }).source).toBe('acquisition')
  })

  it('a docx transcript takes its meeting date before the file modification date', () => {
    const created = new Date('2026-06-03T08:00:00Z')
    const fileModifiedDate = new Date('2026-10-20T08:00:00Z')
    const fileName = '3Giugno2026 - Riunione di prova.docx'
    // The meeting header of the text comes as the system's date, then the name, the creation.
    expect(
      documentDate({
        ...base,
        systemDate: day(2026, 6, 2),
        fileName,
        metadataDate: created,
        fileModifiedDate,
      }),
    ).toEqual({ date: day(2026, 6, 2), source: 'system' })
    expect(documentDate({ ...base, fileName, metadataDate: created, fileModifiedDate })).toEqual({
      date: day(2026, 6, 3),
      source: 'file_name',
    })
    const unnamed = 'Riunione di prova.docx'
    expect(
      documentDate({ ...base, fileName: unnamed, metadataDate: created, fileModifiedDate }),
    ).toEqual({ date: created, source: 'metadata' })
    expect(documentDate({ ...base, fileName: unnamed, fileModifiedDate })).toEqual({
      date: fileModifiedDate,
      source: 'file_modified',
    })
    const ahead = new Date('2027-01-01T00:00:00Z')
    expect(documentDate({ ...base, fileName: unnamed, fileModifiedDate: ahead }).source).toBe(
      'acquisition',
    )
  })
})

describe('meetingDateInText', () => {
  it.each([
    ['Riunione di prova\n3 giugno 2026, 10:02\n45m 3s\n\nAnna: buongiorno', day(2026, 6, 3)],
    ['Riunione di prova\n3 giugno 2026 10:02:15\n1h 2m 5s\n', day(2026, 6, 3)],
    ['Riunione di prova\n\nJune 3, 2026, 10:02AM\n45m 3s\n', day(2026, 6, 3)],
    ['Weekly\n25 September 2026, 9:00 AM\n12m\n', day(2026, 9, 25)],
    ['Weekly\n6 ago 2026\n50s\n', day(2026, 8, 6)],
  ])('reads the meeting date of the header of a transcript (%#)', (text, date) => {
    expect(meetingDateInText(text, 'it')).toEqual(date)
  })

  it.each([
    // A date without the length of the recording after it is not the header.
    'Riunione di prova\n3 giugno 2026, 10:02\nAnna: buongiorno',
    // A date inside a sentence is any day the meeting talked about.
    'Anna: ci vediamo il 3 giugno 2026\n45m 3s',
    // Past the first lines.
    'a\nb\nc\nd\ne\nf\n3 giugno 2026\n45m 3s',
    'Riunione\n31 giugno 2026\n45m 3s',
    '',
  ])('takes no date that is not the header of a transcript (%#)', (text) => {
    expect(meetingDateInText(text, 'it')).toBeNull()
  })

  it('a long text stays fast', () => {
    const text = `${'3 giugno 2026 '.repeat(20_000)}\n45m`
    expect(meetingDateInText(text, 'it')).toBeNull()
  })
})

describe('redated', () => {
  type Source = Parameters<typeof isCertainDate>[0]
  const at = (source: Source) => ({ date: day(2026, 1, 1), source })

  it('a better date replaces a weaker one', () => {
    expect(redated(at('acquisition'), at('file_name'))).toEqual(at('file_name'))
    expect(redated(at('file_modified'), at('metadata'))).toEqual(at('metadata'))
    expect(redated(at('metadata'), at('system'))).toEqual(at('system'))
  })

  it('a date as good or weaker is not taken', () => {
    expect(redated(at('file_name'), at('file_name'))).toBeNull()
    expect(redated(at('system'), at('file_name'))).toBeNull()
  })

  it('a PM correction of the date is never overwritten by re-dating', () => {
    expect(redated(at('pm'), at('system'))).toBeNull()
  })

  it('only a date from the PM, a system, a name or the metadata is certain', () => {
    const certain: Source[] = ['pm', 'system', 'file_name', 'metadata']
    expect(certain.every(isCertainDate)).toBe(true)
    expect(isCertainDate('file_modified')).toBe(false)
    expect(isCertainDate('acquisition')).toBe(false)
  })
})
