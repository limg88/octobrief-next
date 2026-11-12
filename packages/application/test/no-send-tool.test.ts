import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReadLog, newId, type ProjectId } from '@octobrief/domain/recipe'
import { describe, expect, it } from 'vitest'
import { projectTools, trackerTool } from '../src/index.ts'

// The model is offered reading tools only. There is no tool that sends a mail, makes a draft or
// writes anywhere: a client mail is text the PM copies after approving it.

const projectId = newId<ProjectId>()

const READING_TOOLS = [
  'get_fact',
  'list_sources',
  'query_tracker',
  'read_evidence',
  'search_knowledge',
]

const WRITING_WORDS = /send|mail|draft|reply|forward|post|write|create|update|delete|publish/i

function everyTool() {
  const log = createReadLog()
  const withTx = async <T>(fn: (tx: unknown) => Promise<T>) => fn(null)
  return [
    ...projectTools({ projectId, lang: 'it', log, reader: {} as never, withTx }),
    trackerTool({
      projectId,
      lang: 'it',
      log,
      tracker: {} as never,
      withTx,
      now: new Date('2026-11-05T12:00:00Z'),
    }),
  ]
}

describe('the tools the model is offered', () => {
  it('offers no tool to send a mail, to make a draft or to write', () => {
    const names = everyTool()
      .map((t) => t.spec.name)
      .sort()
    expect(names).toEqual(READING_TOOLS)
    expect(names.filter((n) => WRITING_WORDS.test(n))).toEqual([])
  })

  it('gives each tool a description of reading, not of sending', () => {
    for (const t of everyTool()) {
      expect(t.spec.description, t.spec.name).not.toMatch(/\b(send|sends|draft|reply)\b/i)
    }
  })

  it('has no tool defined anywhere in the engine sources besides those', () => {
    const dir = join(import.meta.dirname, '../src')
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath, e.name))
    const declared = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/spec:\s*\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]),
    )
    expect([...new Set(declared)].sort()).toEqual(READING_TOOLS)
  })
})
