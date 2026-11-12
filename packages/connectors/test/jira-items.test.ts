import { describe, expect, it } from 'vitest'
import {
  growthSlope,
  HANG_GUARD_MS,
  MAX_GROWTH_SLOPE,
  TIMING_TEST_TIMEOUT_MS,
} from '../../domain/test/timing.ts'
import { ConnectorError } from '../src/errors.ts'
import {
  adfToText,
  MAX_ADF_DEPTH,
  MAX_ADF_MENTIONS,
  MAX_ADF_NODES,
  MAX_ADF_TEXT,
  readAdf,
} from '../src/jira/adf.ts'
import type { JiraConfig } from '../src/jira/config.ts'
import { exportCsv, issueOf, MAX_DESCRIPTION } from '../src/jira/issues.ts'
import {
  CLOCK_SKEW_MARGIN_MINUTES,
  jqlSince,
  MAX_RELATIVE_MINUTES,
  syncJql,
} from '../src/jira/jql.ts'
import { adf, jiraIssue, jqlInstant } from './support/fake-jira.ts'

const text = (t: string) => ({ type: 'text', text: t })
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const docOf = (content: unknown[]) => ({ type: 'doc', version: 1, content })
const doc = (...content: unknown[]) => docOf(content)

describe('the text of an ADF document', () => {
  it('keeps paragraphs, breaks, lists, tables and inline names as lines of text', () => {
    const value = doc(
      { type: 'heading', attrs: { level: 1 }, content: [text('Titolo')] },
      para(
        text('Uno '),
        { type: 'mention', attrs: { id: 'x', text: '@Lucia' } },
        { type: 'hardBreak' },
        text('due'),
      ),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para(text('primo'))] },
          {
            type: 'listItem',
            content: [
              para(text('secondo '), { type: 'emoji', attrs: { shortName: ':ok:', text: '👍' } }),
            ],
          },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para(text('A'))] },
              { type: 'tableCell', content: [para(text('B'))] },
            ],
          },
        ],
      },
      para({ type: 'inlineCard', attrs: { url: 'https://example.test/x' } }),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm', type: 'file' } }] },
      { type: 'unknownNode', content: [text('dentro')] },
    )
    expect(adfToText(value)).toBe(
      'Titolo\nUno @Lucia\ndue\n- primo\n- secondo 👍\nA\nB\nhttps://example.test/x\ndentro',
    )
  })

  it('gives no text for what is not a document', () => {
    for (const value of [null, undefined, 'testo', 42, [], { type: 7 }]) {
      expect(adfToText(value)).toBe('')
    }
  })

  it('does not read below the depth limit, nor beyond the node and text limits', () => {
    let deep: unknown = text('fondo')
    for (let i = 0; i < 100_000; i += 1) deep = { type: 'blockquote', content: [deep] }
    expect(adfToText(doc(para(text('cima')), deep))).toBe('cima')
    expect(MAX_ADF_DEPTH).toBe(32)

    const wide = docOf(Array.from({ length: 1_000_000 }, (_, i) => para(text(`p${i}`))))
    const lines = adfToText(wide).split('\n')
    expect(lines.length).toBeLessThan(MAX_ADF_NODES)
    expect(lines[0]).toBe('p0')

    const long = adfToText(doc(para(text('a'.repeat(MAX_ADF_TEXT)), text('FINE'))))
    expect(long).not.toContain('FINE')
  })

  it(
    'takes time linear in hostile input',
    () => {
      const shapes: Record<string, (n: number) => unknown> = {
        wide: (n) => docOf(Array.from({ length: n }, () => para(text('x')))),
        deep: (n) => {
          let node: unknown = text('x')
          for (let i = 0; i < n; i += 1) node = { type: 'paragraph', content: [node, text('y')] }
          return doc(node)
        },
        cells: (n) =>
          doc({
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: Array.from({ length: n }, () => ({ type: 'tableCell' })),
              },
            ],
          }),
      }
      for (const [name, build] of Object.entries(shapes)) {
        const { slope, largeMs } = growthSlope((fraction) => {
          const value = build(Math.floor(MAX_ADF_NODES * fraction))
          return () => {
            adfToText(value)
          }
        })
        expect(slope, name).toBeLessThan(MAX_GROWTH_SLOPE)
        expect(largeMs, name).toBeLessThan(HANG_GUARD_MS)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})

describe('the JQL date of a cursor', () => {
  it('is relative to Jira’s clock: minutes since the cursor, rounded up, plus the margin', () => {
    const asOf = new Date('2026-11-05T09:30:00.000Z')
    expect(CLOCK_SKEW_MARGIN_MINUTES).toBe(15)
    expect(jqlSince(new Date('2026-11-05T09:30:00.000Z'), asOf)).toBe('-15m')
    expect(jqlSince(new Date('2026-11-05T09:29:59.999Z'), asOf)).toBe('-16m')
    expect(jqlSince(new Date('2026-11-05T08:30:00.000Z'), asOf)).toBe('-75m')
    // A cursor after the worker's clock (clocks drifting) never gives a date in the future.
    expect(jqlSince(new Date('2026-11-05T09:40:00.000Z'), asOf)).toBe('-15m')
  })

  it('refuses a cursor older than the furthest bound sent, as a cursor that cannot be read', () => {
    const asOf = new Date('2026-11-05T09:30:00.000Z')
    const furthest = new Date(asOf.getTime() - (MAX_RELATIVE_MINUTES - 15) * 60_000)
    expect(jqlSince(furthest, asOf)).toBe(`-${MAX_RELATIVE_MINUTES}m`)
    for (const old of [
      new Date(furthest.getTime() - 60_000),
      new Date('1970-01-01T00:00:00.000Z'),
      new Date(-8.64e15),
    ]) {
      let code = ''
      try {
        jqlSince(old, asOf)
      } catch (error) {
        code = error instanceof ConnectorError ? error.code : 'other'
      }
      expect(code, old.toISOString()).toBe('source_cursor_invalid')
    }
    expect(String(MAX_RELATIVE_MINUTES).length).toBeLessThanOrEqual(9)
  })

  it('is read by Jira at or before the cursor while the clocks differ by up to the margin', () => {
    const asOf = Date.parse('2026-11-05T09:30:00.000Z')
    const margin = CLOCK_SKEW_MARGIN_MINUTES * 60_000
    for (const gap of [0, 1, 999, 59_999, 60_000, 61_000, 3_600_000 + 7, 40 * 86_400_000 + 123]) {
      for (const skew of [-margin, -61_000, 0, 59_999, margin]) {
        const cursor = asOf - gap
        const jiraNow = new Date(asOf + skew)
        const read = jqlInstant(jqlSince(new Date(cursor), new Date(asOf)), jiraNow)
        expect(read, `gap ${gap} skew ${skew}`).toBeLessThanOrEqual(cursor)
      }
    }
  })
})

describe('the JQL of a sync', () => {
  it('names the projects by id and orders by update then key', () => {
    expect(syncJql(['10000', '10001'], '-75m')).toBe(
      'project in (10000, 10001) AND updated >= "-75m" ORDER BY updated ASC, key ASC',
    )
    for (const id of ['APO', '1)', '1 OR 1=1', '"x"', '']) {
      expect(() => syncJql([id], null), id).toThrow()
    }
    for (const since of ['2026/11/01 10:02', '-1d', '"-5m"', '-5m OR 1=1']) {
      expect(() => syncJql(['10000'], since), since).toThrow()
    }
  })
})

const config: JiraConfig = {
  site: 'contoso',
  cloudId: null,
  email: 'a@example.test',
  storyPointsField: null,
  sprintField: null,
  readOnlyToken: true,
}
const PROJECT = { id: '10000', key: 'APO', name: 'Apollo' }

describe('an issue of a search answer', () => {
  it('fails on what is not an issue', () => {
    for (const raw of [
      null,
      { id: '1', key: 'APO-1' },
      { id: 'x', key: 'APO-1', fields: { project: { id: '1' }, updated: '2026-11-01T10:00:00Z' } },
      { id: '1', key: 'APO-1', fields: { project: { id: '1' }, updated: 'ieri' } },
      { id: '1', key: 'APO-1', fields: { updated: '2026-11-01T10:00:00Z' } },
    ]) {
      expect(() => issueOf(raw, config), JSON.stringify(raw)).toThrow()
    }
  })

  it('cuts a long description on a character, never inside one', () => {
    const issue = jiraIssue(1, 'APO-1', PROJECT, {
      updated: '2026-11-01T10:00:00.000+0000',
      description: adf(`${'a'.repeat(MAX_DESCRIPTION - 1)}😀😀`),
    })
    const read = issueOf(issue, config)
    expect([...(read.description ?? '')]).toHaveLength(MAX_DESCRIPTION)
    expect(read.description?.endsWith('a😀')).toBe(true)
  })

  it('is exported with formulas neutralized', () => {
    const issue = issueOf(
      jiraIssue(1, 'APO-1', PROJECT, {
        updated: '2026-11-01T10:00:00.000+0000',
        summary: '=HYPERLINK("x")',
      }),
      config,
    )
    const line = new TextDecoder().decode(exportCsv([issue])).split('\r\n')[1]
    expect(line).toContain(`,"'=HYPERLINK(""x"")",`)
  })
})

describe('the people of an issue', () => {
  it('marks an app of the Jira site as not a person', () => {
    const issue = jiraIssue(1, 'APO-1', PROJECT, {
      updated: '2026-11-01T10:00:00.000+0000',
    }) as unknown as {
      fields: { assignee: Record<string, unknown> }
    }
    expect(issueOf(issue, config).assignee).not.toHaveProperty('app')
    issue.fields.assignee.accountType = 'app'
    expect(issueOf(issue, config).assignee).toMatchObject({ app: true })
    // A customer of a service desk names themselves.
    issue.fields.assignee.accountType = 'customer'
    expect(issueOf(issue, config).assignee).toMatchObject({ untrusted: true })
  })

  it('counts the people its description and comments mention, never only as text', () => {
    const mention = (name: string) => ({
      type: 'mention',
      attrs: { id: '557058:aaaa-synthetic', text: `@${name}` },
    })
    const issue = issueOf(
      jiraIssue(1, 'APO-1', PROJECT, {
        updated: '2026-11-01T10:00:00.000+0000',
        description: doc(
          para(text('Confermato con '), mention('Lucrezia Fantini'), text(' del cliente')),
        ),
        comments: [
          {
            id: '10',
            author: { displayName: 'Anna Riva' },
            created: '2026-11-01T09:00:00.000+0000',
            body: doc(para(mention('Ugo Neri'), text(' puoi verificare?'))),
          },
        ],
      }),
      config,
    )
    expect(issue.description).toBe('Confermato con @Lucrezia Fantini del cliente')
    expect(issue.mentioned).toEqual([{ displayName: 'Lucrezia Fantini', untrusted: true }])
    expect(issue.comments[0]?.mentioned).toEqual([{ displayName: 'Ugo Neri', untrusted: true }])
  })

  it('keeps at most so many mentions of one document, and refuses the document beyond', () => {
    const many = Array.from({ length: MAX_ADF_MENTIONS + 5 }, (_, i) => ({
      type: 'mention',
      attrs: { text: `@Persona Sintetica ${i}` },
    }))
    const read = readAdf(doc(para(...many, { type: 'mention', attrs: { id: 'x' } })))
    expect(read.mentions).toHaveLength(MAX_ADF_MENTIONS)
    // One more than kept: the item is left out, never sent with that name unhidden.
    expect(read.mentionsRefused).toBe(true)
    expect(readAdf(doc(para({ type: 'mention', attrs: { text: '@' } })))).toMatchObject({
      mentions: [],
      mentionsRefused: false,
    })
    const long = readAdf(doc(para({ type: 'mention', attrs: { text: `@${'x'.repeat(201)}` } })))
    expect(long.mentionsRefused).toBe(true)
  })
})
