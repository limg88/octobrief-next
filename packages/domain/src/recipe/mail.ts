import type { ActionReason, AvailableActions } from '../gate/approval.ts'
import type { ClientDocument, InternalDocument } from '../gate/audience.ts'
import type { Lang } from '../language/index.ts'
import { romeDateString } from '../rome-time.ts'
import type { DocumentBlock, DocumentCell, DocumentSection } from './document-model.ts'
import { recipeText } from './messages/index.ts'

// The client mail as a draft to copy. Octobrief never sends a mail and never creates a draft in
// a mailbox (that would be a write to the mail): the PM copies the text of the approved
// sections and pastes it where they write. The sections are `subject` and `body` of the client
// version; the internal notes stay apart and never enter what is copied. The recipients come
// from the parameter of the recipe or from the team of the project, and the code (not the model,
// which never sees an address) reports those who are not in the team.

/** The section of the recipe that holds the subject, and the one that holds the body. */
export const MAIL_SUBJECT_SECTION = 'subject'
export const MAIL_BODY_SECTION = 'body'

/** The parameter of the recipe that may name the recipients. */
export const MAIL_RECIPIENTS_PARAMETER = 'recipients'

export type MailTextKey =
  | 'subject_label'
  | 'copy_not_approved'
  | 'not_deduced'
  | 'data_as_of'
  | 'data_as_of_unknown'
  | 'sources_title'
  | 'recipient_outside_team'
  | 'recipient_invalid'

/** A person of the project team, as far as the mail needs: the address, when the login gave one. */
export interface TeamAddress {
  displayName: string
  email: string | null
}

/** A syntactically plausible address: no spaces, brackets, quotes or separators. */
const ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/

/**
 * The addresses written in a parameter, separated by commas, semicolons or spaces: lower case,
 * without repeats, in the order written; what does not look like an address is reported apart.
 */
export function parseRecipients(raw: unknown): { valid: string[]; invalid: string[] } {
  if (typeof raw !== 'string') return { valid: [], invalid: [] }
  const valid: string[] = []
  const invalid: string[] = []
  for (const piece of raw.split(/[\s,;]+/)) {
    if (piece === '') continue
    if (!ADDRESS.test(piece)) {
      if (!invalid.includes(piece)) invalid.push(piece)
      continue
    }
    const address = piece.toLowerCase()
    if (!valid.includes(address)) valid.push(address)
  }
  return { valid, invalid }
}

/**
 * The text of a stored parameter. A run stores its parameters typed (`{ type: 'text', value }`),
 * so that is the only shape read: a bare string is not what the production path writes.
 */
function typedText(stored: unknown): string | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined
  const { type, value } = stored as { type?: unknown; value?: unknown }
  return type === 'text' && typeof value === 'string' ? value : undefined
}

export interface MailRecipients {
  to: string[]
  outsideTeam: string[]
  invalid: string[]
}

/** The recipients: those the parameter names, else the team of the project with a known address. */
export function mailRecipients(
  parameters: Readonly<Record<string, unknown>>,
  team: readonly TeamAddress[],
): MailRecipients {
  const teamAddresses = [
    ...new Set(team.flatMap((m) => (m.email === null ? [] : [m.email.trim().toLowerCase()]))),
  ]
  const named = parseRecipients(typedText(parameters[MAIL_RECIPIENTS_PARAMETER]))
  if (named.valid.length === 0 && named.invalid.length === 0) {
    return { to: teamAddresses, outsideTeam: [], invalid: [] }
  }
  return {
    to: named.valid,
    outsideTeam: named.valid.filter((a) => !teamAddresses.includes(a)),
    invalid: named.invalid,
  }
}

// Text of the sections ---------------------------------------------------------------------------

/** A day in Italy as the PM writes it: `gg/mm/aaaa`. */
function italianDay(instant: string): string {
  const [y, m, d] = romeDateString(new Date(instant)).split('-')
  return `${d}/${m}/${y}`
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

interface Rendering {
  lang: Lang
  /** Source markers and tables as Markdown. */
  markdown: boolean
}

/** The numbers of the source notes a datum cites, as it is copied: `[1][2]`. */
const marks = (sources: readonly number[]): string =>
  sources.length === 0 ? '' : ` ${[...new Set(sources)].map((n) => `[${n}]`).join('')}`

function cellText(cell: DocumentCell, r: Rendering): string {
  if (cell.text === null) return recipeText('mail', 'not_deduced', {}, r.lang)
  return `${oneLine(cell.text)}${marks(cell.sources)}`
}

function blockText(block: DocumentBlock, r: Rendering): string {
  const notDeduced = recipeText('mail', 'not_deduced', {}, r.lang)
  switch (block.kind) {
    case 'static':
      return block.text
    case 'value':
      return `${block.label}: ${cellText(block.cell, r)}`
    case 'text': {
      if (block.notDeduced || block.segments.length === 0) return notDeduced
      return block.segments.map((s) => `${s.text}${marks(s.sources)}`).join(' ')
    }
    case 'list': {
      if (block.notDeduced || block.items.length === 0) return notDeduced
      return block.items
        .map((i) => `- ${i.cells.map((c) => cellText(c, r)).join(' – ')}`)
        .join('\n')
    }
    case 'table': {
      if (block.notDeduced || block.rows.length === 0) return notDeduced
      const line = (cells: readonly string[]) =>
        r.markdown
          ? `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
          : cells.join(' | ')
      const head = line(block.columns.map((c) => c.title))
      const rule = r.markdown ? `\n|${block.columns.map(() => ' --- ').join('|')}|` : ''
      const rows = block.rows.map((row) => line(row.cells.map((c) => cellText(c, r))))
      return [`${head}${rule}`, ...rows].join('\n')
    }
  }
}

function sectionText(section: DocumentSection | undefined, r: Rendering): string {
  if (section === undefined) return ''
  if (section.notDeduced) return recipeText('mail', 'not_deduced', {}, r.lang)
  return section.blocks
    .map((b) => {
      const body = blockText(b, r)
      return r.markdown && 'title' in b && b.title !== undefined
        ? `### ${b.title}\n\n${body}`
        : body
    })
    .join('\n\n')
}

// The mail ---------------------------------------------------------------------------------------

export interface MailDraft {
  subject: string
  /** The body as plain text, to paste. */
  body: string
  /**
   * What «Copia testo» puts on the clipboard, and the only thing the page copies: the subject and
   * the body with the numbered source notes and the date of the data, nothing else.
   */
  copyText: string
  /** The same in Markdown, with the sources and the date of the data. */
  markdown: string
  /** The recipients, for the PM to check; never part of the text and never sent to the model. */
  recipients: string[]
  /** Recipients that are not in the team of the project. */
  outsideTeam: string[]
  /** Notes for the PM only: the internal notes of the draft and what the code found in the recipients. */
  internalNotes: string[]
}

export type MailRefusal = ActionReason | 'not_a_mail'

export type MailResult = { ok: true; mail: MailDraft } | { ok: false; reason: MailRefusal }

export interface MailInput {
  /** The actions of the PM on the revision, recomputed by the server: the copy is `download`. */
  actions: AvailableActions
  /** The client version of the approved revision; null for a recipe with no client version. */
  client: ClientDocument | null
  /** The internal notes of the approved draft. */
  internalNotes: InternalDocument['internalNotes']
  /** The parameters the run was started with. */
  parameters: Readonly<Record<string, unknown>>
  team: readonly TeamAddress[]
  lang: Lang
}

/**
 * The text to copy and the Markdown of an approved client mail. Nothing before the approval (the
 * same availability as the file), and nothing for a deliverable that is not a mail.
 */
export function mailCopy(input: MailInput): MailResult {
  const download = input.actions.download
  if (!download.available) return { ok: false, reason: download.reason ?? 'not_approved' }
  const doc = input.client
  const subjectSection = doc?.sections.find((s) => s.id === MAIL_SUBJECT_SECTION)
  const bodySection = doc?.sections.find((s) => s.id === MAIL_BODY_SECTION)
  if (doc === null || subjectSection === undefined || bodySection === undefined) {
    return { ok: false, reason: 'not_a_mail' }
  }
  const lang = input.lang
  const plain: Rendering = { lang, markdown: false }
  const marked: Rendering = { lang, markdown: true }
  const subject = oneLine(sectionText(subjectSection, plain))
  const body = sectionText(bodySection, plain)
  const label = recipeText('mail', 'subject_label', {}, lang)

  const notes = doc.sourceNotes.map((n) => `[${n.n}] ${n.label}`)
  const asOf = doc.header.dataAsOf
  const date = recipeText(
    'mail',
    asOf === null ? 'data_as_of_unknown' : 'data_as_of',
    {
      ...(asOf === null ? {} : { asOf: italianDay(asOf) }),
      generated: italianDay(doc.header.generatedAt),
    },
    lang,
  )
  // What is copied keeps the source and the date of the data it shows: the numbered notes and
  // the date line follow the body, in the text and in the Markdown alike.
  const sourcesTitle = recipeText('mail', 'sources_title', {}, lang)
  const copyText = [
    `${label}: ${subject}`,
    body,
    ...(notes.length === 0 ? [] : [[sourcesTitle, ...notes].join('\n')]),
    date,
  ].join('\n\n')
  const markdown = [
    `**${label}:** ${oneLine(sectionText(subjectSection, marked))}`,
    sectionText(bodySection, marked),
    '---',
    ...(notes.length === 0 ? [] : [`**${sourcesTitle}**\n\n${notes.join('\n')}`]),
    date,
  ].join('\n\n')

  const recipients = mailRecipients(input.parameters, input.team)
  const internalNotes = [
    ...input.internalNotes.map((n) => n.text),
    ...(recipients.outsideTeam.length === 0
      ? []
      : [
          recipeText(
            'mail',
            'recipient_outside_team',
            { addresses: recipients.outsideTeam.join(', ') },
            lang,
          ),
        ]),
    ...(recipients.invalid.length === 0
      ? []
      : [
          recipeText(
            'mail',
            'recipient_invalid',
            { addresses: recipients.invalid.join(', ') },
            lang,
          ),
        ]),
  ]
  return {
    ok: true,
    mail: {
      subject,
      body,
      copyText,
      markdown,
      recipients: recipients.to,
      outsideTeam: recipients.outsideTeam,
      internalNotes,
    },
  }
}
