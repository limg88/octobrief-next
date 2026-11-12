// A fake Jira for the demo: one synthetic project with bugs and change requests.
// Usage: node demo/09-analisi-bug/fake-jira.ts <file to write the origin to>
import { writeFileSync } from 'node:fs'
import { jiraIssue, startFakeJira } from '../../packages/connectors/test/support/fake-jira.ts'

const BOREA = { id: '10001', key: 'BOR', name: 'Borea' }
const mario = { displayName: 'Mario Rossi', emailAddress: 'mario.rossi@example.test' }
const at = (day: string) => `2026-${day}T10:00:00.000+0100`

const fake = await startFakeJira({
  email: 'octobrief@example.test',
  token: 'token-finto-demo',
  projects: [BOREA],
  issues: [
    jiraIssue(1, 'BOR-1', BOREA, {
      type: 'Bug',
      summary: 'Il report mensile non si apre',
      status: 'In Progress',
      priority: 'High',
      assignee: mario,
      created: at('10-06'),
      updated: at('11-03'),
    }),
    jiraIssue(2, 'BOR-2', BOREA, {
      type: 'Bug',
      summary: 'Totale errato nella dashboard',
      status: 'Done',
      priority: 'Medium',
      assignee: mario,
      created: at('10-08'),
      resolved: at('10-20'),
      updated: at('10-20'),
    }),
    jiraIssue(3, 'BOR-3', BOREA, {
      type: 'Bug',
      summary: 'Filtro per data non applicato',
      status: 'To Do',
      priority: 'Low',
      assignee: null,
      created: at('10-25'),
      updated: at('10-25'),
    }),
    jiraIssue(4, 'BOR-4', BOREA, {
      type: 'Change Request',
      summary: 'Esportazione in CSV dei report',
      status: 'Done',
      priority: 'Medium',
      assignee: mario,
      created: at('10-02'),
      resolved: at('10-28'),
      updated: at('10-28'),
    }),
    jiraIssue(5, 'BOR-5', BOREA, {
      type: 'Change Request',
      summary: 'Nuovo campo «centro di costo»',
      status: 'To Do',
      priority: 'High',
      assignee: mario,
      created: at('10-15'),
      updated: at('10-30'),
    }),
    jiraIssue(6, 'BOR-6', BOREA, {
      type: 'Story',
      summary: 'Pagina dei report',
      status: 'In Progress',
      assignee: mario,
      created: at('10-01'),
      updated: at('11-02'),
    }),
  ],
})
const target = process.argv[2]
if (target) writeFileSync(target, fake.server.origin)
console.log(`Fake Jira on ${fake.server.origin}`)
