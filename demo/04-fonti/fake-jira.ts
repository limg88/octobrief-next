// A fake Jira for the demo: one synthetic project with three issues, on a loopback port.
// Usage: node demo/04-fonti/fake-jira.ts <file to write the origin to>
import { writeFileSync } from 'node:fs'
import { jiraIssue, startFakeJira } from '../../packages/connectors/test/support/fake-jira.ts'

export const FAKE_JIRA_EMAIL = 'octobrief@example.test'
export const FAKE_JIRA_TOKEN = 'token-finto-demo'

const BOREA = { id: '10001', key: 'BOR', name: 'Borea' }
const ALTRO = { id: '10002', key: 'ALT', name: 'Altro progetto' }
const mario = { displayName: 'Mario Rossi', emailAddress: 'mario.rossi@example.test' }

const fake = await startFakeJira({
  email: FAKE_JIRA_EMAIL,
  token: FAKE_JIRA_TOKEN,
  projects: [BOREA, ALTRO],
  issues: [
    jiraIssue(1, 'BOR-1', BOREA, {
      updated: '2026-11-03T10:00:00.000+0100',
      summary: 'Modulo di reportistica',
      status: 'In Progress',
      assignee: mario,
    }),
    jiraIssue(2, 'BOR-2', BOREA, {
      updated: '2026-11-04T09:30:00.000+0100',
      summary: 'Collaudo con il cliente',
      status: 'To Do',
      assignee: mario,
    }),
    jiraIssue(3, 'BOR-3', BOREA, {
      updated: '2026-11-04T16:00:00.000+0100',
      summary: 'Migrazione dei dati',
      status: 'Done',
      assignee: null,
    }),
    jiraIssue(4, 'ALT-1', ALTRO, { updated: '2026-11-04T16:00:00.000+0100' }),
  ],
})
const target = process.argv[2]
if (target) writeFileSync(target, fake.server.origin)
console.log(`Fake Jira on ${fake.server.origin}`)
