import { FeedError } from '@octobrief/application'
import { RecordingLogger } from '@octobrief/application/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeJira, jiraIssue, startFakeJira } from '../../connectors/test/support/fake-jira.ts'
import { createConnectorFeeds } from '../src/feeds/connector-feeds.ts'

const BOREA = { id: '10001', key: 'BOR', name: 'Borea' }
const APOLLO = { id: '10000', key: 'APO', name: 'Apollo' }
const EMAIL = 'octobrief@example.test'
const CONFIG = { site: 'contoso', email: EMAIL, readOnlyToken: true }

describe('Jira through the connector feeds', () => {
  let fake: FakeJira
  afterEach(() => fake?.server.close())

  async function start() {
    fake = await startFakeJira({
      email: EMAIL,
      token: 'token-ok',
      projects: [APOLLO, BOREA],
      issues: [
        jiraIssue(1, 'BOR-1', BOREA, {
          updated: '2026-11-04T10:00:00.000+0100',
          summary: 'Report mensile',
          assignee: { displayName: 'Mario Rossi', emailAddress: 'mario.rossi@example.test' },
        }),
        jiraIssue(2, 'APO-1', APOLLO, { updated: '2026-11-04T11:00:00.000+0100' }),
      ],
    })
    const logger = new RecordingLogger()
    const feeds = createConnectorFeeds({ logger, devEndpoints: { jira: fake.server.origin } })
    return { feeds, logger }
  }

  it('checks the credential and keeps the projects the PM named', async () => {
    const { feeds } = await start()
    const all = await feeds.connect('jira', CONFIG, 'token-ok', [])
    expect(all.perimeter).toEqual(['project:10000', 'project:10001'])
    const one = await feeds.connect('jira', CONFIG, 'token-ok', [' bor '])
    expect(one).toMatchObject({
      config: { site: 'contoso', email: EMAIL },
      perimeter: ['project:10001'],
    })
    const byName = await feeds.connect('jira', CONFIG, 'token-ok', ['borea (bor)'])
    expect(byName.perimeter).toEqual(['project:10001'])
  })

  it('refuses a wrong credential, bad settings and a scope that matches nothing, by code', async () => {
    const { feeds } = await start()
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error: unknown) => (error instanceof FeedError ? error.code : 'unexpected'),
      )
    expect(await codeOf(feeds.connect('jira', CONFIG, 'wrong', []))).toBe('source_auth_failed')
    expect(await codeOf(feeds.connect('jira', { site: 'contoso' }, 'token-ok', []))).toBe(
      'source_not_configured',
    )
    expect(await codeOf(feeds.connect('jira', CONFIG, 'token-ok', ['ZZZ']))).toBe(
      'source_not_configured',
    )
    expect(await codeOf(feeds.connect('ado', { organization: 'x' }, 'pat', ['Borea']))).toBe(
      'source_not_configured',
    )
  })

  it('reads the issues of the perimeter as records and their export as a document', async () => {
    const { feeds } = await start()
    const source = {
      kind: 'jira' as const,
      config: CONFIG,
      perimeter: ['project:10001'],
      secret: 'token-ok',
    }
    const signal = new AbortController().signal
    const batch = await feeds.pull(source, null, signal)
    expect(batch.records.map((record) => record.title)).toEqual(['Report mensile'])
    expect(batch.records[0]?.people).toContainEqual({
      displayName: 'Mario Rossi',
      email: 'mario.rossi@example.test',
    })
    expect(batch.documents.map((document) => document.systemKind)).toEqual(['backlog_export'])
    expect(batch.done).toBe(true)
    const again = await feeds.pull(source, batch.nextCursor, signal)
    expect(again.records).toEqual([])
    await expect(feeds.pull(source, { nonsense: true }, signal)).rejects.toMatchObject({
      code: 'source_cursor_invalid',
    })
  })
})
