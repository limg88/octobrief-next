// A synthetic synchronized folder, as the sync add-on would write it: tracker items of a fake
// project «Borea» under jira/, a mail and a meeting under m365/. Synthetic data only.
// Usage: node demo/12-cartella-sincronizzata/make-folder.ts <folder> [second-pass]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderSyncFile,
  SYNC_REMOVED_FILE,
  SYNC_STATE_DIR,
  SYNC_STATE_FILE,
  type SyncFile,
} from '../../packages/connectors/src/index.ts'

const [root, pass] = process.argv.slice(2)
if (!root) {
  console.error('usage: make-folder.ts <folder> [second-pass]')
  process.exit(2)
}
const secondPass = pass === 'second-pass'
const at = (day: string) => `2026-${day}T09:00:00.000Z`

interface Issue {
  id: string
  key: string
  type: 'Bug' | 'Change Request' | 'Story'
  title: string
  status: 'To Do' | 'In Progress' | 'Done'
  priority: 'High' | 'Medium' | 'Low'
  created: string
  updated: string
  resolved?: string
}

const issues: Issue[] = [
  {
    id: '1',
    key: 'BOR-1',
    type: 'Bug',
    title: 'Il report mensile non si apre',
    status: 'In Progress',
    priority: 'High',
    created: at('10-06'),
    updated: at('11-03'),
  },
  {
    id: '2',
    key: 'BOR-2',
    type: 'Bug',
    title: 'Totale errato nella dashboard',
    status: 'Done',
    priority: 'Medium',
    created: at('10-08'),
    updated: at('10-20'),
    resolved: at('10-20'),
  },
  {
    id: '3',
    key: 'BOR-3',
    type: 'Bug',
    title: 'Filtro per data non applicato',
    status: 'To Do',
    priority: 'Low',
    created: at('10-25'),
    updated: at('10-25'),
  },
  {
    id: '4',
    key: 'BOR-4',
    type: 'Change Request',
    title: 'Esportazione in formato CSV',
    status: 'In Progress',
    priority: 'High',
    created: at('10-10'),
    updated: at('10-28'),
  },
  {
    id: '5',
    key: 'BOR-5',
    type: 'Change Request',
    title: 'Nuovo campo nel modulo ordini',
    status: 'Done',
    priority: 'Medium',
    created: at('10-12'),
    updated: at('10-22'),
    resolved: at('10-22'),
  },
  {
    id: '6',
    key: 'BOR-6',
    type: 'Story',
    title: 'Pagina dei report',
    status: 'To Do',
    priority: 'Medium',
    created: at('10-15'),
    updated: at('10-15'),
  },
]
// The second pass: the bug in progress was closed at the source, the story was removed.
if (secondPass) {
  Object.assign(issues[0] as Issue, { status: 'Done', updated: at('11-12'), resolved: at('11-12') })
  issues.pop()
}

const CATEGORY = { 'To Do': 'new', 'In Progress': 'indeterminate', Done: 'done' } as const
const issueFile = (issue: Issue): SyncFile => ({
  system: 'jira',
  type: 'record',
  body: `# ${issue.key} — ${issue.title}\n\n- Tipo: ${issue.type}\n- Stato: ${issue.status}\n- Priorità: ${issue.priority}\n`,
  record: {
    externalId: issue.id,
    version: issue.updated,
    title: issue.title,
    originAt: new Date(issue.updated),
    url: `https://jira.example.test/browse/${issue.key}`,
    people: [{ displayName: 'Mario Rossi', email: 'mario.rossi@example.test' }],
    record: {
      key: issue.key,
      type: issue.type,
      labels: [],
      sprint: null,
      status: issue.status,
      dueDate: null,
      sprints: [],
      assignee: 'Mario Rossi',
      comments: [],
      priority: issue.priority,
      createdAt: issue.created,
      parentKey: null,
      updatedAt: issue.updated,
      projectKey: 'BOR',
      resolvedAt: issue.resolved ?? null,
      description: null,
      storyPoints: null,
      statusCategory: CATEGORY[issue.status],
    },
  },
})

const carla = {
  displayName: 'Carla Cliente',
  email: 'carla.cliente@cliente.example',
  untrusted: true,
}
const paola = { displayName: 'Paola Prova', email: 'paola.prova@example.test' }
const mail: SyncFile = {
  system: 'm365',
  type: 'document',
  via: 'claude',
  externalId: 'mail-budget-1',
  version: at('11-10'),
  title: 'RE Budget Borea',
  originAt: new Date(at('11-10')),
  url: null,
  people: [carla, paola],
  body: 'Da: Carla Cliente <carla.cliente@cliente.example>\nA: Paola Prova\nData: 10 novembre 2026\nOggetto: RE: Budget Borea\n\nIl budget approvato dal comitato resta di 890.000 euro.\nCarla Cliente deve confermare la data del collaudo entro venerdì.\n',
}
const meeting: SyncFile = {
  system: 'm365',
  type: 'document',
  via: 'claude',
  externalId: 'meeting-weekly-1',
  version: at('11-11'),
  title: 'Allineamento settimanale Borea',
  originAt: new Date(at('11-11')),
  url: null,
  systemKind: 'transcript',
  people: [carla, paola],
  body: "Riunione Teams dell'11 novembre 2026. Partecipanti: Paola Prova, Carla Cliente.\n\nCarla Cliente: il rischio principale resta il ritardo del fornitore.\nPaola Prova: la consegna del modulo è prevista per il 30 novembre 2026.\n",
}

function write(path: string, content: string) {
  mkdirSync(join(root as string, path, '..'), { recursive: true })
  writeFileSync(join(root as string, path), content)
}

rmSync(join(root, 'jira'), { recursive: true, force: true })
for (const issue of issues) write(`jira/${issue.key}.md`, renderSyncFile(issueFile(issue)))
write('m365/mail/2026-11-10-re-budget-borea.md', renderSyncFile(mail))
write('m365/riunioni/2026-11-11-allineamento-settimanale.md', renderSyncFile(meeting))
write(
  `${SYNC_STATE_DIR}/${SYNC_STATE_FILE}`,
  JSON.stringify({
    jira: { dataAsOf: at(secondPass ? '11-12' : '11-11') },
    m365: { dataAsOf: at('11-11') },
  }),
)
write(`${SYNC_STATE_DIR}/${SYNC_REMOVED_FILE}`, JSON.stringify({ jira: secondPass ? ['6'] : [] }))
console.log(`${issues.length} attività, 1 mail e 1 riunione in ${root}`)
