import { execFile } from 'node:child_process'
import { FeederError, type Provider } from '../feeder.ts'
import type { WireDelivery } from '../wire.ts'

/** The longest a command may take, and the most it may print. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export interface CommandOptions {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly timeoutMs?: number
}

/**
 * The first JSON object of a text: a command may wrap its answer in prose or in a fenced block.
 * Null when there is none.
 */
export function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // Not an object ending here: try a shorter one.
      }
    }
  }
  return null
}

/** What a command printed, as a delivery: the object itself, or the `result` text of Claude. */
export function deliveryOf(output: string): WireDelivery {
  const parsed = firstJsonObject(output) as Record<string, unknown> | null
  const inner = typeof parsed?.result === 'string' ? firstJsonObject(parsed.result) : parsed
  const delivery = inner as WireDelivery | null
  if (!delivery || !Array.isArray(delivery.documents)) {
    throw new FeederError('provider_failed', 'the command printed no delivery')
  }
  return delivery
}

/**
 * Runs a program on the PM's computer and delivers the JSON it prints. This is how Microsoft 365
 * is read without Graph permissions: the program is Claude with the PM's own M365 connector,
 * asked (read-only) for mails, meetings and files as a delivery.
 */
export function commandProvider(options: CommandOptions): Provider {
  return {
    name: options.name,
    async *deliveries() {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          options.command,
          [...options.args],
          { timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
          (error, stdout) => {
            if (error) reject(new FeederError('provider_failed', `${options.command} failed`))
            else resolve(stdout)
          },
        )
      })
      yield deliveryOf(output)
    },
  }
}

/** The request made to Claude for a Microsoft 365 delivery; `query` and `days` come from the PM. */
export function m365Prompt(query: string, days: number): string {
  return [
    'Usa SOLO strumenti di lettura del connettore Microsoft 365: non inviare, non modificare, non eliminare nulla.',
    `Cerca mail, riunioni Teams (con trascrizione, se c'è) e file SharePoint degli ultimi ${days} giorni che riguardano: ${query}.`,
    'Rispondi con UN SOLO oggetto JSON, senza altro testo, di questa forma:',
    '{"dataAsOf":"<ora ISO 8601 UTC>","documents":[{"externalId":"<id stabile dell\'elemento>","version":"<data di ultima modifica ISO>","title":"<oggetto o titolo>","mediaType":"text/markdown","text":"<per una mail: Da, A, Data, Oggetto e corpo; per una riunione: titolo, data, partecipanti e trascrizione; per un file: il suo testo>","originAt":"<data ISO dell\'elemento>","url":"<link web o null>","people":[{"displayName":"<nome>","email":"<email>","untrusted":<true se esterno all\'organizzazione>}]}]}',
    'Elenca in `people` OGNI persona nominata (mittente, destinatari, partecipanti). Al massimo 50 elementi. Non riassumere: riporta il testo.',
  ].join('\n')
}

export function m365Provider(options: { query: string; days: number; claude?: string }): Provider {
  return commandProvider({
    name: 'm365',
    command: options.claude ?? 'claude',
    args: ['-p', m365Prompt(options.query, options.days), '--output-format', 'json'],
  })
}
