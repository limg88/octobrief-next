import type { ExternalPerson, Json } from '../port.ts'
import { csvDocument, exportTitle as titleOf } from '../shared/export.ts'
import { cutToCharacters } from '../shared/text.ts'
import { bad, date, isRecord, num, text } from '../shared/values.ts'
import { readAdf } from './adf.ts'
import type { JiraConfig } from './config.ts'

/**
 * The fields asked of every issue: nothing else, never `*all`. Worklog and time tracking
 * (`worklog`, `timetracking`, `timespent`, `timeoriginalestimate`, `timeestimate` and their
 * `aggregate…` sums) are never asked and never read: hours come from DWSI or uploaded exports.
 */
export const ISSUE_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'assignee',
  'priority',
  'project',
  'created',
  'updated',
  'resolutiondate',
  'duedate',
  'labels',
  'parent',
  'description',
  'comment',
] as const

/** The fields of a configuration: the declared ones and the configured custom fields. */
export function issueFields(cfg: JiraConfig): string[] {
  return [
    ...ISSUE_FIELDS,
    ...(cfg.storyPointsField !== null ? [cfg.storyPointsField] : []),
    ...(cfg.sprintField !== null ? [cfg.sprintField] : []),
  ]
}

/** The longest description kept, in characters of text. */
export const MAX_DESCRIPTION = 8_000
/** The comments kept of an issue: the last ones. */
export const MAX_COMMENTS = 50
/** The longest comment kept, in characters of text. */
export const MAX_COMMENT = 1_000

export interface IssueComment {
  id: string
  author: ExternalPerson | null
  createdAt: Date | null
  text: string
  /** The people its text mentions. */
  mentioned: ExternalPerson[]
  /** It mentions more people than kept, or a name too long to be one. */
  mentionsRefused: boolean
}

/** An issue as the connector keeps it: plain values, texts from ADF. */
export interface Issue {
  id: string
  key: string
  projectId: string
  projectKey: string
  type: string
  status: string
  statusCategory: string | null
  summary: string
  assignee: ExternalPerson | null
  priority: string | null
  storyPoints: number | null
  /** The active sprint, or the last one the issue was in. */
  sprint: string | null
  sprints: string[]
  labels: string[]
  parentKey: string | null
  createdAt: Date | null
  updatedAt: Date
  resolvedAt: Date | null
  /** A date without time (`yyyy-MM-dd`), as Jira gives it. */
  dueDate: string | null
  description: string | null
  /** The people the description mentions. */
  mentioned: ExternalPerson[]
  /** The description mentions more people than kept, or a name too long to be one. */
  mentionsRefused: boolean
  /** The last comments, oldest first. */
  comments: IssueComment[]
  /** How many comments the issue has: more than those inline means they are read apart. */
  commentTotal: number
  /** How many comments the search gave inline. */
  commentsInline: number
}

const ID = /^\d{1,18}$/

function personOf(v: unknown): ExternalPerson | null {
  if (!isRecord(v)) return null
  const displayName = text(v.displayName)?.trim()
  if (!displayName) return null
  const email = text(v.emailAddress)
  const person: ExternalPerson = email?.includes('@') ? { displayName, email } : { displayName }
  // An app of the Jira site (automation, an integration) is not a person.
  if (v.accountType === 'app') person.app = true
  // A customer of a service desk names themselves: untrusted.
  if (v.accountType === 'customer') person.untrusted = true
  return person
}

const nameOf = (v: unknown): string | null => (isRecord(v) ? text(v.name) : null)

/** A comment of Jira (inline in a search or from the comment list); null when it is not one. */
export function commentOf(raw: unknown): IssueComment | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) return null
  const body = readAdf(raw.body)
  return {
    id: raw.id,
    author: personOf(raw.author),
    createdAt: date(raw.created),
    text: cutToCharacters(body.text, MAX_COMMENT),
    mentioned: body.mentions,
    mentionsRefused: body.mentionsRefused,
  }
}

/** The last comments of a list, oldest first, at most `MAX_COMMENTS`. */
export function lastComments(raw: readonly unknown[]): IssueComment[] {
  const comments = raw.flatMap((c) => {
    const comment = commentOf(c)
    return comment ? [comment] : []
  })
  const at = (c: IssueComment) => c.createdAt?.getTime() ?? 0
  comments.sort((a, b) => at(a) - at(b) || Number(a.id) - Number(b.id))
  return comments.slice(-MAX_COMMENTS)
}

function sprintsOf(v: unknown): { sprint: string | null; sprints: string[] } {
  if (!Array.isArray(v)) return { sprint: null, sprints: [] }
  const all = v.flatMap((s) => {
    const name = isRecord(s) ? text(s.name) : null
    return name !== null && isRecord(s) ? [{ name, state: s.state }] : []
  })
  const active = all.find((s) => s.state === 'active')
  return { sprint: active?.name ?? all.at(-1)?.name ?? null, sprints: all.map((s) => s.name) }
}

/**
 * An issue of a search answer, read for the declared fields only (whatever else the answer
 * holds is never looked at); a value that is not an issue is a bad response.
 */
export function issueOf(raw: unknown, cfg: JiraConfig): Issue {
  if (!isRecord(raw) || !isRecord(raw.fields)) return bad()
  const f = raw.fields
  const project = isRecord(f.project) ? f.project : bad()
  const updatedAt = date(f.updated)
  if (
    typeof raw.id !== 'string' ||
    !ID.test(raw.id) ||
    typeof raw.key !== 'string' ||
    raw.key === '' ||
    raw.key.length > 255 ||
    typeof project.id !== 'string' ||
    !ID.test(project.id) ||
    updatedAt === null
  ) {
    return bad()
  }
  const { text: description, mentions, mentionsRefused } = readAdf(f.description)
  const comment = isRecord(f.comment) ? f.comment : null
  const inline = Array.isArray(comment?.comments) ? comment.comments : []
  const total = num(comment?.total)
  const labels = Array.isArray(f.labels) ? f.labels : []
  const parent = isRecord(f.parent) ? text(f.parent.key) : null
  const due = text(f.duedate)
  return {
    id: raw.id,
    key: raw.key.normalize('NFC'),
    projectId: project.id,
    projectKey: text(project.key) ?? '',
    type: nameOf(f.issuetype) ?? '',
    status: nameOf(f.status) ?? '',
    statusCategory:
      isRecord(f.status) && isRecord(f.status.statusCategory)
        ? text(f.status.statusCategory.key)
        : null,
    summary: (text(f.summary) ?? '').trim(),
    assignee: personOf(f.assignee),
    priority: nameOf(f.priority),
    storyPoints: cfg.storyPointsField === null ? null : num(f[cfg.storyPointsField]),
    ...sprintsOf(cfg.sprintField === null ? null : f[cfg.sprintField]),
    labels: labels.flatMap((l) => {
      const label = text(l)
      return label ? [label] : []
    }),
    parentKey: parent,
    createdAt: date(f.created),
    updatedAt,
    resolvedAt: date(f.resolutiondate),
    dueDate: due !== null && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    description: description === '' ? null : cutToCharacters(description, MAX_DESCRIPTION),
    mentioned: mentions,
    mentionsRefused,
    comments: lastComments(inline),
    commentTotal: total !== null && Number.isInteger(total) && total > 0 ? total : inline.length,
    commentsInline: inline.length,
  }
}

/**
 * Whether the comments inline in the search are not all of them (the search may give the first
 * ones only): then the last ones are read apart.
 */
export const commentsCut = (issue: Issue): boolean => issue.commentsInline < issue.commentTotal

const iso = (d: Date | null) => d?.toISOString() ?? null

/** The structured record of an issue in the tracker history (the title is added by the job). */
export function recordOf(issue: Issue): Record<string, Json> {
  return {
    key: issue.key,
    type: issue.type,
    status: issue.status,
    statusCategory: issue.statusCategory,
    assignee: issue.assignee?.displayName ?? null,
    priority: issue.priority,
    storyPoints: issue.storyPoints,
    sprint: issue.sprint,
    sprints: issue.sprints,
    projectKey: issue.projectKey,
    labels: issue.labels,
    parentKey: issue.parentKey,
    createdAt: iso(issue.createdAt),
    updatedAt: issue.updatedAt.toISOString(),
    resolvedAt: iso(issue.resolvedAt),
    dueDate: issue.dueDate,
    description: issue.description,
    comments: issue.comments.map((c) => ({
      author: c.author?.displayName ?? null,
      createdAt: iso(c.createdAt),
      text: c.text,
    })),
  }
}

const EXPORT_COLUMNS = [
  'Issue id',
  'Issue key',
  'Issue Type',
  'Summary',
  'Status',
  'Assignee',
  'Priority',
  'Sprint',
  'Story Points',
  'Project key',
  'Labels',
  'Parent',
  'Created',
  'Updated',
  'Resolved',
  'Due date',
  'Description',
  'Comments',
]

/** The comments of an issue in one cell: a line each, date, author and text. */
function commentsCell(issue: Issue): string | null {
  if (issue.comments.length === 0) return null
  const lines = issue.comments.map(
    (c) => `${iso(c.createdAt) ?? ''}; ${c.author?.displayName ?? ''}; ${c.text}`,
  )
  return cutToCharacters(lines.join('\n'), MAX_DESCRIPTION)
}

/**
 * The export of the issues read, as Jira names its columns: one line per issue, comma separated
 * (RFC 4180). The time of the export is in its title, not in its content, so the same issues
 * read again give the same document.
 */
export function exportCsv(issues: readonly Issue[]): Uint8Array {
  return csvDocument(
    EXPORT_COLUMNS,
    issues.map((i) => [
      i.id,
      i.key,
      i.type,
      i.summary,
      i.status,
      i.assignee?.displayName ?? null,
      i.priority,
      i.sprint,
      i.storyPoints,
      i.projectKey,
      i.labels.join('; '),
      i.parentKey,
      iso(i.createdAt),
      i.updatedAt.toISOString(),
      iso(i.resolvedAt),
      i.dueDate,
      i.description,
      commentsCell(i),
    ]),
  )
}

/** «Export Jira del gg/mm hh:mm», at the time in Italy. */
export function exportTitle(at: Date): string {
  return titleOf('Jira', at)
}
