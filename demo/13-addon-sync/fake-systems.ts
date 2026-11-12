// The fake systems of demo 13: a Jira and an Azure DevOps with a synthetic project «Borea».
// Usage: node demo/13-addon-sync/fake-systems.ts <file to write the two origins to>
// Send SIGUSR2 to play what happens at the sources between two passes of the add-on:
// a Jira bug is closed and a new Azure DevOps item appears.
import { writeFileSync } from 'node:fs'
import { startFakeAdo, workItem } from '../../packages/connectors/test/support/fake-ado.ts'
import { jiraIssue, startFakeJira } from '../../packages/connectors/test/support/fake-jira.ts'

const BOREA = { id: '10001', key: 'BOR', name: 'Borea' }
const mario = { displayName: 'Mario Rossi', emailAddress: 'mario.rossi@example.test' }
const at = (day: string) => `2026-${day}T10:00:00.000+0100`
const AREA = 'Borea\\Portale'
const SPRINT = 'Borea\\Sprint 1'

const issues = [
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
    type: 'Change Request',
    summary: 'Esportazione in CSV dei report',
    status: 'To Do',
    priority: 'Medium',
    assignee: mario,
    created: at('10-12'),
    updated: at('10-28'),
  }),
  // Changed before the start day of the demo (1 October): never read.
  jiraIssue(4, 'BOR-4', BOREA, {
    type: 'Bug',
    summary: 'Vecchio errore di stampa',
    status: 'Done',
    priority: 'Low',
    assignee: mario,
    created: at('08-01'),
    resolved: at('08-20'),
    updated: at('08-20'),
  }),
]
const items = [
  workItem(101, {
    area: AREA,
    iteration: SPRINT,
    changedAt: '2026-10-15T09:00:00.000Z',
    createdAt: '2026-10-10T09:00:00.000Z',
    type: 'Bug',
    title: 'Login lento dal portale',
    state: 'Active',
    priority: 1,
    assignedTo: { displayName: 'Mario Rossi', uniqueName: 'mario.rossi@example.test' },
  }),
  workItem(102, {
    area: AREA,
    iteration: SPRINT,
    changedAt: '2026-10-22T09:00:00.000Z',
    createdAt: '2026-10-12T09:00:00.000Z',
    type: 'User Story',
    title: 'Filtri nella pagina degli ordini',
    state: 'Closed',
    closedAt: '2026-10-22T09:00:00.000Z',
    storyPoints: 5,
  }),
]

const jira = await startFakeJira({
  email: 'octobrief@example.test',
  token: 'token-finto-demo',
  projects: [BOREA],
  issues,
})
const ado = await startFakeAdo({
  organization: 'contoso',
  projectId: '11111111-1111-4111-8111-111111111111',
  projectName: 'Borea',
  pat: 'pat-finto-demo',
  areas: [{ name: 'Portale' }],
  iterations: [{ name: 'Sprint 1' }],
  items,
})
writeFileSync(process.argv[2] as string, `${jira.server.origin}\n${ado.server.origin}\n`)

process.on('SIGUSR2', () => {
  // A quarter of an hour ago: what changed in the last ten minutes is left to the next pass.
  const changed = new Date(Date.now() - 15 * 60_000).toISOString()
  const closed = jiraIssue(1, 'BOR-1', BOREA, {
    type: 'Bug',
    summary: 'Il report mensile non si apre',
    status: 'Done',
    priority: 'High',
    assignee: mario,
    created: at('10-06'),
    resolved: changed,
    updated: changed,
  })
  const index = jira.options.issues.findIndex((issue) => issue.id === closed.id)
  jira.options.issues[index] = closed
  ado.options.items.push(
    workItem(103, {
      area: AREA,
      iteration: SPRINT,
      changedAt: changed,
      createdAt: changed,
      type: 'Bug',
      title: 'Errore al salvataggio di un ordine',
      state: 'New',
      priority: 2,
    }),
  )
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    Promise.all([jira.server.close(), ado.server.close()]).finally(() => process.exit(0))
  })
}
