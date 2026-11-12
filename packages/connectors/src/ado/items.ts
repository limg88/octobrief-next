import type { ExternalPerson, Json } from '../port.ts'
import { csvDocument, exportTitle as titleOf } from '../shared/export.ts'
import { htmlTextAndMentions } from '../shared/html.ts'
import { cutToCharacters } from '../shared/text.ts'
import { bad, date, num, text } from '../shared/values.ts'

export { htmlToText, MAX_DESCRIPTION_HTML } from '../shared/html.ts'

/** The fields read of every work item: nothing else is asked. */
export const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AssignedTo',
  'System.AreaPath',
  'System.IterationPath',
  'System.Tags',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'Microsoft.VSTS.Scheduling.Effort',
  'Microsoft.VSTS.Common.Priority',
  'System.CreatedDate',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.ClosedDate',
  'System.Parent',
  'System.Description',
] as const

/** The longest description kept, in characters of text. */
export const MAX_DESCRIPTION = 8_000

/** A work item as the connector keeps it: plain values, the description in text. */
export interface WorkItem {
  id: number
  rev: number
  type: string
  title: string
  state: string
  assignedTo: ExternalPerson | null
  areaPath: string
  iterationPath: string
  tags: string[]
  storyPoints: number | null
  priority: number | null
  /** When the work item was created; null when the system does not give it. */
  createdAt: Date | null
  changedAt: Date
  closedAt: Date | null
  parentId: number | null
  description: string | null
  /** The people its description mentions. */
  mentioned: ExternalPerson[]
  /** The description mentions more people than kept, or a name too long to be one. */
  mentionsRefused: boolean
}

function personOf(v: unknown): ExternalPerson | null {
  if (typeof v !== 'object' || v === null) return null
  const identity = v as Record<string, unknown>
  const displayName = text(identity.displayName)?.trim()
  if (!displayName) return null
  const unique = text(identity.uniqueName)
  const person: ExternalPerson = unique?.includes('@')
    ? { displayName, email: unique }
    : { displayName }
  // Build and service identities of Azure DevOps («Project Collection Build Service») are not people.
  const descriptor = text(identity.descriptor) ?? ''
  if (descriptor.startsWith('svc.') || unique?.startsWith('Build\\')) person.app = true
  return person
}

/** A work item of a `workitemsbatch` answer; a value that is not one is a bad response. */
export function workItemOf(raw: unknown): WorkItem {
  if (typeof raw !== 'object' || raw === null) return bad()
  const item = raw as Record<string, unknown>
  const fields = (
    typeof item.fields === 'object' && item.fields !== null ? item.fields : bad()
  ) as Record<string, unknown>
  const id = num(item.id)
  const rev = num(item.rev)
  const changedAt = date(fields['System.ChangedDate'])
  if (id === null || !Number.isInteger(id) || id <= 0 || rev === null || changedAt === null) {
    return bad()
  }
  const description = fields['System.Description']
  const {
    text: plain,
    mentions,
    mentionsRefused,
  } = typeof description === 'string'
    ? htmlTextAndMentions(description)
    : { text: '', mentions: [], mentionsRefused: false }
  const parent = num(fields['System.Parent'])
  return {
    id,
    rev,
    type: text(fields['System.WorkItemType']) ?? '',
    title: (text(fields['System.Title']) ?? '').trim(),
    state: text(fields['System.State']) ?? '',
    assignedTo: personOf(fields['System.AssignedTo']),
    areaPath: text(fields['System.AreaPath']) ?? '',
    iterationPath: text(fields['System.IterationPath']) ?? '',
    tags: (text(fields['System.Tags']) ?? '')
      .split(';')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    storyPoints:
      num(fields['Microsoft.VSTS.Scheduling.StoryPoints']) ??
      num(fields['Microsoft.VSTS.Scheduling.Effort']),
    priority: num(fields['Microsoft.VSTS.Common.Priority']),
    createdAt: date(fields['System.CreatedDate']),
    changedAt,
    closedAt: date(fields['Microsoft.VSTS.Common.ClosedDate']),
    parentId: parent !== null && Number.isInteger(parent) ? parent : null,
    description: plain === '' ? null : cutToCharacters(plain, MAX_DESCRIPTION),
    // The text of a mention link is free text of the writer: untrusted.
    mentioned: mentions.map((displayName) => ({ displayName, untrusted: true as const })),
    mentionsRefused,
  }
}

/** The structured record of a work item in the tracker history (the title is added by the job). */
export function recordOf(item: WorkItem): Record<string, Json> {
  return {
    type: item.type,
    state: item.state,
    assignedTo: item.assignedTo?.displayName ?? null,
    areaPath: item.areaPath,
    iterationPath: item.iterationPath,
    tags: item.tags,
    storyPoints: item.storyPoints,
    priority: item.priority,
    createdAt: item.createdAt?.toISOString() ?? null,
    changedAt: item.changedAt.toISOString(),
    closedAt: item.closedAt?.toISOString() ?? null,
    parentId: item.parentId === null ? null : String(item.parentId),
    description: item.description,
  }
}

const EXPORT_COLUMNS = [
  'ID',
  'Work Item Type',
  'Title',
  'State',
  'Assigned To',
  'Area Path',
  'Iteration Path',
  'Tags',
  'Story Points',
  'Priority',
  'Created Date',
  'Changed Date',
  'Closed Date',
  'Parent',
  'Description',
]

/**
 * The export of the work items read, as Azure DevOps names its columns: one line per work item,
 * comma separated (RFC 4180). The time of the export is in its title, not in its content, so
 * the same items read again give the same document.
 */
export function exportCsv(items: readonly WorkItem[]): Uint8Array {
  return csvDocument(
    EXPORT_COLUMNS,
    items.map((i) => [
      i.id,
      i.type,
      i.title,
      i.state,
      i.assignedTo?.displayName ?? null,
      i.areaPath,
      i.iterationPath,
      i.tags.join('; '),
      i.storyPoints,
      i.priority,
      i.createdAt?.toISOString() ?? null,
      i.changedAt.toISOString(),
      i.closedAt?.toISOString() ?? null,
      i.parentId,
      i.description,
    ]),
  )
}

/** «Export ADO del gg/mm hh:mm», at the time in Italy. */
export function exportTitle(at: Date): string {
  return titleOf('ADO', at)
}
