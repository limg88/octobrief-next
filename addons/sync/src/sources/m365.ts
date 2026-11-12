import { execFile } from 'node:child_process'
import { romeDateString } from '@octobrief/domain'
import type { SyncConfig } from '../config.ts'
import { FeederError } from '../feeder.ts'
import { deliveryOf, firstJsonObject } from '../providers/command.ts'
import { fromWire } from '../wire.ts'
import type { SourceBatch, SystemSource } from './source.ts'

type M365Config = NonNullable<SyncConfig['m365']>

/** What is asked of Microsoft 365, one call each: mail, Teams, files. */
export const M365_SECTIONS = ['mail', 'teams', 'file'] as const
export type M365Section = (typeof M365_SECTIONS)[number]

/** The subfolder of `m365/` each section is written into. */
export const SECTION_FOLDERS: Readonly<Record<M365Section, string>> = {
  mail: 'mail',
  teams: 'riunioni',
  file: 'file',
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Days one call asks for: a week of a project fits in the items one answer may carry. */
export const WINDOW_DAYS = 7
/** Days read again before the point reached, for what arrived late or changed since. */
export const OVERLAP_DAYS = 1
/** Items one answer may carry; more than that and the window is split. */
export const MAX_ITEMS_PER_ANSWER = 50
/** Windows one run reads at most; a longer catch-up goes on at the next run. */
export const MAX_WINDOWS_PER_RUN = 80
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export interface Window {
  readonly from: Date
  readonly to: Date
}

/** The windows that cover a period, oldest first; the last one may be shorter. */
export function windowsOf(from: Date, to: Date, days = WINDOW_DAYS): Window[] {
  const windows: Window[] = []
  for (let start = from.getTime(); start < to.getTime(); start += days * DAY_MS) {
    windows.push({
      from: new Date(start),
      to: new Date(Math.min(start + days * DAY_MS, to.getTime())),
    })
  }
  return windows
}

const quoted = (values: readonly string[]): string => values.map((v) => `«${v}»`).join(', ')

/** What a section looks for, in words; null when the configuration asks nothing of it. */
function scopeOf(section: M365Section, config: M365Config): string | null {
  const own =
    section === 'mail'
      ? [
          config.outlook.folders.length
            ? `nelle cartelle di Outlook ${quoted(config.outlook.folders)}`
            : '',
          config.outlook.mailboxes.length
            ? `nelle caselle condivise o delegate ${quoted(config.outlook.mailboxes)}`
            : '',
        ]
      : section === 'teams'
        ? [
            config.teams.channels.length ? `nei canali ${quoted(config.teams.channels)}` : '',
            config.teams.chats.length ? `nelle chat ${quoted(config.teams.chats)}` : '',
          ]
        : [
            config.sharepoint.paths.length
              ? `sotto i percorsi ${quoted(config.sharepoint.paths)}`
              : '',
          ]
  const places = own.filter(Boolean)
  const words = config.keywords.length
    ? `che contengono o riguardano una di queste parole, frasi o indirizzi email (mittente, destinatario o partecipante): ${quoted(config.keywords)}`
    : ''
  if (places.length === 0 && words === '') return null
  return [places.join(' e '), words].filter(Boolean).join('; oppure ')
}

const WHAT: Readonly<Record<M365Section, string>> = {
  mail: 'le mail di Outlook (ricevute e inviate)',
  teams:
    'le riunioni di Teams con la loro trascrizione, e i messaggi di canali e chat di Teams (un elemento per riunione; per canali e chat, un elemento per conversazione e giorno)',
  file: 'i file di SharePoint e OneDrive (Word, Excel, PowerPoint, PDF) creati o modificati',
}
const TEXT: Readonly<Record<M365Section, string>> = {
  mail: 'Da, A, Cc, Data, Oggetto e il corpo completo',
  teams: 'titolo, data e ora, partecipanti e la trascrizione o i messaggi completi, con chi parla',
  file: 'il testo completo del file',
}

/** What Claude answers when the session it runs in has no Microsoft 365 connector. */
export const CONNECTOR_UNAVAILABLE = 'connector_unavailable'
const UNAVAILABLE_RULE = `Se in questa sessione non hai strumenti del connettore Microsoft 365, rispondi solo {"error":"${CONNECTOR_UNAVAILABLE}"}.`

/** The request made to Claude for one section over one window; null when nothing is asked. */
export function m365Prompt(
  section: M365Section,
  config: M365Config,
  window: Window,
): string | null {
  const scope = scopeOf(section, config)
  if (scope === null) return null
  return [
    'Usa SOLO strumenti di lettura del connettore Microsoft 365: non inviare, non modificare, non eliminare nulla.',
    `Cerca ${WHAT[section]} dal ${romeDateString(window.from)} (compreso) al ${romeDateString(window.to)} (escluso), ${scope}.`,
    'Rispondi con UN SOLO oggetto JSON, senza altro testo, di questa forma:',
    `{"truncated":<true se gli elementi trovati sono più di ${MAX_ITEMS_PER_ANSWER}>,"documents":[{"externalId":"<id stabile dell'elemento nel sistema>","version":"<data di ultima modifica ISO 8601>","title":"<oggetto o titolo>","mediaType":"text/markdown","text":"<${TEXT[section]}>","originAt":"<data ISO 8601 dell'elemento>","url":"<link web o null>"${section === 'teams' ? ',"kind":"transcript se è la trascrizione di una riunione, altrimenti ometti"' : ''},"people":[{"displayName":"<nome>","email":"<email>","untrusted":<true se esterno all'organizzazione>}]}]}`,
    UNAVAILABLE_RULE,
    `Elenca in "people" OGNI persona nominata (mittente, destinatari, partecipanti). Al massimo ${MAX_ITEMS_PER_ANSWER} elementi, i più recenti. Non riassumere e non tradurre: riporta il testo com'è. Se non trovi nulla rispondi {"truncated":false,"documents":[]}.`,
  ].join('\n')
}

/** Runs Claude with a prompt and gives what it printed. */
export type ClaudeRunner = (prompt: string) => Promise<string>

/** Claude on the PM's computer, headless, allowed to use only the tools named. */
export function claudeRunner(config: M365Config): ClaudeRunner {
  return (prompt) =>
    new Promise((resolve, reject) => {
      execFile(
        config.claude,
        [
          '-p',
          prompt,
          '--output-format',
          'json',
          '--allowedTools',
          config.allowedTools.join(','),
          ...(config.model ? ['--model', config.model] : []),
        ],
        { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout) => {
          if (error) reject(new FeederError('provider_failed', `${config.claude} failed`))
          else resolve(stdout)
        },
      )
    })
}

/** The object Claude answered with: the text of its `result`, or what it printed. */
function answerOf(output: string): Record<string, unknown> | null {
  const parsed = firstJsonObject(output) as Record<string, unknown> | null
  const inner = typeof parsed?.result === 'string' ? firstJsonObject(parsed.result) : parsed
  return inner as Record<string, unknown> | null
}

/**
 * Fails when Claude says it could not read: an answer with an `error` is never taken for "nothing
 * found". Only the known code is repeated; any other text of the model stays out of the report.
 */
function refuseError(output: string): void {
  const error = answerOf(output)?.error
  if (error === undefined || error === null || error === '') return
  const code = error === CONNECTOR_UNAVAILABLE ? CONNECTOR_UNAVAILABLE : 'claude_error'
  throw new FeederError('provider_failed', `m365: ${code}`)
}

/** Whether the answer says there was more than it could carry. */
const truncatedIn = (output: string): boolean => answerOf(output)?.truncated === true

/**
 * Asks Claude, without reading any data, whether it has the Microsoft 365 connector: fails as a
 * source would when it has not, or when Claude cannot be run.
 */
export async function probeM365(run: ClaudeRunner): Promise<void> {
  const output = await run(
    `Non leggere alcun dato e non chiamare strumenti di lettura. ${UNAVAILABLE_RULE} Altrimenti rispondi solo {"connector":"available"}.`,
  )
  refuseError(output)
  if (answerOf(output) === null) throw new FeederError('provider_failed', 'm365: claude_error')
}

/**
 * Microsoft 365 through Claude and the PM's own connector, read-only. The period from the point
 * reached (or the start day) to now is read window by window and section by section; a window
 * with more items than an answer carries is split in two. The cursor is the point reached: it
 * moves only when every section of a window has been written, so nothing is skipped by a run
 * that stops halfway.
 */
export function m365Source(
  config: M365Config,
  run: ClaudeRunner,
  now: () => Date = () => new Date(),
): SystemSource {
  async function* section(
    name: M365Section,
    window: Window,
  ): AsyncGenerator<SourceBatch['delivery']> {
    const prompt = m365Prompt(name, config, window)
    if (prompt === null) return
    const output = await run(prompt)
    refuseError(output)
    const span = window.to.getTime() - window.from.getTime()
    if (truncatedIn(output) && span > DAY_MS) {
      const middle = new Date(window.from.getTime() + Math.ceil(span / 2 / DAY_MS) * DAY_MS)
      yield* section(name, { from: window.from, to: middle })
      yield* section(name, { from: middle, to: window.to })
      return
    }
    yield fromWire(deliveryOf(output))
  }

  return {
    system: 'm365',
    writer: { via: 'claude' },
    startCursor: (since) => (since ? { until: since.toISOString() } : null),
    async *batches(cursor) {
      const end = now()
      const reached = (cursor as { until?: string; first?: boolean } | null)?.until
      const from = reached
        ? new Date(new Date(reached).getTime() - OVERLAP_DAYS * DAY_MS)
        : new Date(end.getTime() - config.days * DAY_MS)
      let until = reached ?? from.toISOString()
      for (const window of windowsOf(from, end).slice(0, MAX_WINDOWS_PER_RUN)) {
        for (const name of M365_SECTIONS) {
          for await (const delivery of section(name, window)) {
            yield {
              delivery,
              cursor: { until },
              writer: { via: 'claude', groupOf: () => SECTION_FOLDERS[name] },
            }
          }
        }
        until = window.to.toISOString()
        yield { delivery: fromWire({ dataAsOf: until }), cursor: { until } }
      }
    },
  }
}
