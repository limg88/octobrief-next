import type { ExternalPerson } from '../port.ts'
import { headOf, tidyLines } from '../shared/text.ts'
import { isRecord } from '../shared/values.ts'

/** Nodes of a document looked at, at most: the rest is not read. */
export const MAX_ADF_NODES = 10_000
/** Levels of nesting read: what is deeper is not read. */
export const MAX_ADF_DEPTH = 32
/** Text read of a document, in UTF-16 units: the rest is not read. */
export const MAX_ADF_TEXT = 64 * 1024
/** People mentioned in one document kept at most. */
export const MAX_ADF_MENTIONS = 50
/** The longest name of a mention kept. */
const MAX_MENTION_NAME = 200

/** Nodes that end a line of text. */
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'decisionItem',
  'panel',
  'rule',
  'tableRow',
  'expand',
  'nestedExpand',
  'mediaSingle',
])
/** Nodes whose text is separated from the next by a space. */
const CELLS = new Set(['tableCell', 'tableHeader'])
/** Inline nodes whose text is an attribute. */
const ATTRIBUTE_TEXT: Record<string, string> = {
  mention: 'text',
  emoji: 'text',
  status: 'text',
  inlineCard: 'url',
  blockCard: 'url',
  embedCard: 'url',
}

/** A node whose children are being read: one at a time, so a wide node costs nothing ahead. */
interface Frame {
  children: readonly unknown[]
  next: number
  depth: number
  /** What ends the node: a line break for a block, a space for a cell. */
  after: string
}

/**
 * The person a `mention` node names: its text without the «@»; null when it names no one. The
 * text is whatever the writer put there (not read from the directory by the account id):
 * untrusted.
 */
function mentionOf(attrs: Record<string, unknown>): ExternalPerson | 'too_long' | null {
  const raw = typeof attrs.text === 'string' ? attrs.text : ''
  const displayName = raw.replace(/^@+/, '').trim()
  if (displayName === '') return null
  if (displayName.length > MAX_MENTION_NAME) return 'too_long'
  return { displayName, untrusted: true }
}

/**
 * The text of an Atlassian Document Format value (a description, a comment body), and the people
 * its `mention` nodes name (at most `MAX_ADF_MENTIONS`): a mention is a person of the source,
 * hidden from the model like an assignee. `mentionsRefused` when it names more people, or a name
 * too long to be one: the item is then left out, never sent with a name unhidden. The walk is
 * iterative, with an explicit stack of frames that reads children one at a time: at most
 * `MAX_ADF_NODES` nodes looked at, nothing below `MAX_ADF_DEPTH` levels (so the stack holds at
 * most that many frames), at most `MAX_ADF_TEXT` units of text read; whatever lies beyond is
 * dropped. Blocks become lines (no empty ones), list items start with «- », cells are apart;
 * media, marks and unknown nodes give no text but their children are read.
 */
export function readAdf(doc: unknown): {
  text: string
  mentions: ExternalPerson[]
  mentionsRefused: boolean
} {
  const parts: string[] = []
  const mentions = new Map<string, ExternalPerson>()
  let refused = false
  let read = 0
  let visited = 0
  const frames: Frame[] = []

  const visit = (node: unknown, depth: number) => {
    visited += 1
    if (!isRecord(node) || typeof node.type !== 'string') return
    const type = node.type
    let own: string | null = null
    if (type === 'text' && typeof node.text === 'string') own = node.text
    else if (type === 'hardBreak') own = '\n'
    else if (type in ATTRIBUTE_TEXT && isRecord(node.attrs)) {
      const value = node.attrs[ATTRIBUTE_TEXT[type] as string]
      if (typeof value === 'string') own = value
      const person = type === 'mention' ? mentionOf(node.attrs) : null
      if (person === 'too_long') refused = true
      else if (person && !mentions.has(person.displayName)) {
        if (mentions.size < MAX_ADF_MENTIONS) mentions.set(person.displayName, person)
        else refused = true
      }
    }
    if (own !== null) {
      const piece = headOf(own, MAX_ADF_TEXT - read)
      parts.push(piece)
      read += piece.length
    }
    if (!Array.isArray(node.content) || depth >= MAX_ADF_DEPTH) return
    if (type === 'listItem' || type === 'taskItem') parts.push('- ')
    const after = BLOCKS.has(type) ? '\n' : CELLS.has(type) ? ' ' : ''
    frames.push({ children: node.content, next: 0, depth, after })
  }

  visit(doc, 0)
  while (frames.length > 0 && visited < MAX_ADF_NODES && read < MAX_ADF_TEXT) {
    const top = frames.at(-1) as Frame
    if (top.next >= top.children.length) {
      frames.pop()
      parts.push(top.after)
      continue
    }
    const child = top.children[top.next]
    top.next += 1
    visit(child, top.depth + 1)
  }
  // Blocks nest (a paragraph in a list item, in a cell): one line each, never empty lines.
  const text = tidyLines(parts.join(''))
    .split('\n')
    .filter((line) => line !== '')
    .join('\n')
  return { text, mentions: [...mentions.values()], mentionsRefused: refused }
}

/** The text of an Atlassian Document Format value (`readAdf`). */
export const adfToText = (doc: unknown): string => readAdf(doc).text
