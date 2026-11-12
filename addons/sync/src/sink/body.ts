import type { ExternalRecord, ExternalRows } from '@octobrief/domain'

/** Rows of a view shown in the readable table; all of them are in the header. */
export const MAX_TABLE_ROWS = 50
/** Fields of a tracker item written as text of their own, after the list of the others. */
const LONG_FIELDS = ['description', 'comments'] as const

const scalar = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    const parts = value.map(scalar).filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(', ') : null
  }
  return null
}

/** A cell of a Markdown table: one line, no column separator. */
const cell = (value: unknown): string =>
  (scalar(value) ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ')

function commentsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((comment) => {
    if (typeof comment === 'string') return [comment]
    if (typeof comment !== 'object' || comment === null) return []
    const { author, createdAt, body, text } = comment as Record<string, unknown>
    const said = scalar(body) ?? scalar(text)
    if (!said) return []
    const by = [scalar(author), scalar(createdAt)].filter(Boolean).join(', ')
    return [by ? `**${by}**: ${said}` : said]
  })
}

/**
 * The text of a tracker item for a reader: its title, its fields as a list, then the description
 * and the comments. What a reader does not need to see twice stays in the header only.
 */
export function recordBody(record: ExternalRecord): string {
  const fields = record.record
  const key = scalar(fields.key)
  const lines = [`# ${key ? `${key} — ` : ''}${record.title}`, '']
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'key' || (LONG_FIELDS as readonly string[]).includes(name)) continue
    const shown = scalar(value)
    if (shown !== null) lines.push(`- ${name}: ${shown}`)
  }
  const description = scalar(fields.description)
  if (description) lines.push('', '## Descrizione', '', description)
  const comments = commentsOf(fields.comments)
  if (comments.length > 0) lines.push('', '## Commenti', '', ...comments.map((c) => `- ${c}`))
  if (record.url) lines.push('', record.url)
  return `${lines.join('\n').trimEnd()}\n`
}

/** The rows of a view as a Markdown table, for a reader; long views are shown in part. */
export function rowsBody(rows: ExternalRows): string {
  const columns = [...new Set(rows.rows.flatMap((row) => Object.keys(row.values)))]
  const shown = rows.rows.slice(0, MAX_TABLE_ROWS)
  const lines = [`# ${rows.view} — ${rows.perimeter}`, '', `Righe: ${rows.rows.length}.`]
  if (columns.length > 0 && shown.length > 0) {
    lines.push(
      '',
      `| ${columns.join(' | ')} |`,
      `|${columns.map(() => '---').join('|')}|`,
      ...shown.map((row) => `| ${columns.map((column) => cell(row.values[column])).join(' | ')} |`),
    )
  }
  if (rows.rows.length > shown.length) {
    lines.push('', `Mostrate le prime ${shown.length}: tutte le righe sono nell'intestazione.`)
  }
  return `${lines.join('\n')}\n`
}
