import { describe, expect, it } from 'vitest'
import {
  growthSlope,
  HANG_GUARD_MS,
  MAX_GROWTH_SLOPE,
  TIMING_TEST_TIMEOUT_MS,
} from '../../domain/test/timing.ts'
import {
  exportCsv,
  htmlToText,
  MAX_DESCRIPTION,
  MAX_DESCRIPTION_HTML,
  type WorkItem,
  workItemOf,
} from '../src/ado/items.ts'

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 1,
  rev: 1,
  type: 'Bug',
  title: 'Titolo',
  state: 'Active',
  assignedTo: null,
  areaPath: 'Apollo',
  iterationPath: 'Apollo',
  tags: [],
  storyPoints: null,
  priority: null,
  createdAt: null,
  changedAt: new Date('2026-11-01T10:00:00Z'),
  closedAt: null,
  parentId: null,
  description: null,
  mentioned: [],
  mentionsRefused: false,
  ...over,
})

const lineOf = (w: WorkItem) => new TextDecoder().decode(exportCsv([w])).split('\r\n')[1] as string

describe('the export of work items', () => {
  it('neutralizes a cell a spreadsheet would read as a formula', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      const line = lineOf(item({ title: `${start}HYPERLINK("http://x")` }))
      expect(line, JSON.stringify(start)).toContain(`'${start}HYPERLINK(`)
    }
    expect(lineOf(item({ title: '=1+2' }))).toContain(",'=1+2,")
    // A quoted cell keeps the neutralizing quote inside the quotes.
    expect(lineOf(item({ title: '=A1,"B"' }))).toContain(`,"'=A1,""B""",`)
  })

  it('leaves plain text and numbers as they are', () => {
    const line = lineOf(item({ title: 'Login lento', storyPoints: -3, priority: 1 }))
    expect(line).toContain(',Login lento,')
    expect(line).toContain(',-3,1,')
    expect(line).not.toContain("'")
  })
})

describe('the text of an HTML description', () => {
  it('drops tags and the content of scripts and styles, keeps blocks as lines', () => {
    expect(
      htmlToText(
        '<div>Uno <b>due</b></div><script>alert(1)</script><STYLE>p{}</STYLE><p>tre</p>quattro<br/>cinque',
      ),
    ).toBe('Uno due\ntre\nquattro\ncinque')
    expect(htmlToText('a <!-- nascosto --> b &amp; c &#x1F600; &lt;x&gt;')).toBe('a b & c 😀 <x>')
  })

  it('drops what follows an unclosed comment or script', () => {
    expect(htmlToText('prima <!-- mai chiuso')).toBe('prima')
    expect(htmlToText('prima <script>alert(1)')).toBe('prima')
  })

  it('keeps a «<» that opens no tag, and the text after a tag never closed', () => {
    expect(htmlToText('<p>se a < b allora</p><p>dopo</p>')).toBe('se a < b allora\ndopo')
    expect(htmlToText('3 <5 e 7<=8')).toBe('3 <5 e 7<=8')
    expect(htmlToText('prima <b')).toBe('prima <b')
    expect(htmlToText('stima <2 giorni, poi il resto del testo')).toBe(
      'stima <2 giorni, poi il resto del testo',
    )
  })

  it('reads a «>» inside a quoted attribute as part of the tag', () => {
    expect(htmlToText('<a title="x>y" href=\'a>b\'>link</a> fine')).toBe('link fine')
    expect(htmlToText('<img alt = "1 > 0">testo')).toBe('testo')
    // A quote that is not a value opens nothing.
    expect(htmlToText('<b class=x"y>grassetto</b>')).toBe('grassetto')
  })

  it('ends a tag whose quote never closes at its first «>», so no script leaks as text', () => {
    expect(htmlToText('<a title="x>testo')).toBe('testo')
    expect(htmlToText('<a x="><script>alert(1)</script>dopo')).toBe('dopo')
    // A quote that closes later, even in another tag, keeps everything up to it in the tag.
    expect(htmlToText("<a x='>uno<b y='>due")).toBe('due')
  })

  it('reads at most the first 64 KiB of HTML, markup included', () => {
    expect(MAX_DESCRIPTION_HTML).toBe(64 * 1024)
    const fits = `${'a'.repeat(MAX_DESCRIPTION_HTML - 4)}FINE`
    expect(htmlToText(fits).endsWith('FINE')).toBe(true)
    expect(htmlToText(`${fits}X`).endsWith('FINE')).toBe(true)
    expect(htmlToText(`${'a'.repeat(MAX_DESCRIPTION_HTML)}FINE`)).not.toContain('FINE')
    // The tags count: what they push past the cap is not read.
    const tagged = `${'<b></b>'.repeat(MAX_DESCRIPTION_HTML / 7)}${'a'.repeat(10)}FINE`
    expect(htmlToText(tagged)).not.toContain('FINE')
    expect(htmlToText('<p>uno</p><p>due</p>', 10)).toBe('uno')
  })

  it(
    'takes time linear in hostile input',
    () => {
      for (const unit of [
        '<',
        '<script',
        '<!--',
        '</',
        '<a ',
        '&#',
        '<br>',
        '<a x="',
        '<a x="">',
        '<a x=">',
        '<a x="><script>',
        'a < b',
      ]) {
        const { slope, largeMs } = growthSlope((fraction) => {
          const input = unit.repeat(Math.floor((MAX_DESCRIPTION_HTML * fraction) / unit.length))
          return () => {
            htmlToText(input)
          }
        })
        expect(slope, unit).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs, unit).toBeLessThan(HANG_GUARD_MS)
      }
      const start = Date.now()
      htmlToText('<'.repeat(200_000))
      htmlToText('<script'.repeat(50_000))
      expect(Date.now() - start).toBeLessThan(HANG_GUARD_MS)
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it('cuts a long description on a character, never inside one', () => {
    const description = `${'a'.repeat(MAX_DESCRIPTION - 1)}😀😀`
    const w = workItemOf({
      id: 1,
      rev: 1,
      fields: { 'System.ChangedDate': '2026-11-01T10:00:00Z', 'System.Description': description },
    })
    expect(w.description).toBe(`${'a'.repeat(MAX_DESCRIPTION - 1)}😀`)
    expect([...(w.description ?? '')]).toHaveLength(MAX_DESCRIPTION)
  })
})

describe('the people of a work item', () => {
  const raw = (assignedTo: Record<string, unknown>) => ({
    id: 1,
    rev: 1,
    fields: {
      'System.ChangedDate': '2026-11-01T10:00:00Z',
      'System.AssignedTo': assignedTo,
    },
  })

  it('marks build and service identities as not people, and keeps a person as one', () => {
    expect(
      workItemOf(raw({ displayName: 'Anna Riva', uniqueName: 'anna@contoso.example' })).assignedTo,
    ).toEqual({ displayName: 'Anna Riva', email: 'anna@contoso.example' })
    for (const service of [
      { displayName: 'Project Collection Build Service (contoso)', descriptor: 'svc.abc' },
      { displayName: 'Apollo Build Service', uniqueName: 'Build\\1234' },
    ]) {
      expect(workItemOf(raw(service)).assignedTo).toMatchObject({ app: true })
    }
  })

  it('counts the people its description mentions among its people, never only as text', () => {
    const w = workItemOf({
      id: 1,
      rev: 1,
      fields: {
        'System.ChangedDate': '2026-11-01T10:00:00Z',
        'System.Description':
          '<div><a href="#" data-vss-mention="version:2.0,0000-synthetic">@Lucrezia Fantini</a> ' +
          'conferma il rilascio con <a data-vss-mention="version:2.0,1111" href="#">@Ugo&nbsp;Neri</a>' +
          ' e <a href="https://example.com">un link</a></div>',
      },
    })
    expect(w.description).toBe('@Lucrezia Fantini conferma il rilascio con @Ugo Neri e un link')
    expect(w.mentioned).toEqual([
      { displayName: 'Lucrezia Fantini', untrusted: true },
      { displayName: 'Ugo Neri', untrusted: true },
    ])
    expect(w.mentionsRefused).toBe(false)
  })

  it('refuses a description with more mentions than kept, or a name too long to be one', () => {
    const link = (name: string) => `<a data-vss-mention="version:2.0,x">@${name}</a> `
    const of = (html: string) =>
      workItemOf({
        id: 1,
        rev: 1,
        fields: { 'System.ChangedDate': '2026-11-01T10:00:00Z', 'System.Description': html },
      })
    const many = of(Array.from({ length: 51 }, (_, i) => link(`Persona Sintetica ${i}`)).join(''))
    expect(many).toMatchObject({ mentionsRefused: true, mentioned: [] })
    expect(of(link('x'.repeat(201)))).toMatchObject({ mentionsRefused: true, mentioned: [] })
  })
})
