import { type KnownPerson, type ProjectId, Pseudonymizer } from '@octobrief/domain'
import {
  type ChatMessage,
  MAX_EMBEDDING_TEXT_CHARS,
  type ModelRunner,
  type ToolCall,
} from '../ports/model-runner.ts'
import { peopleMatcherFor } from './people-matchers.ts'

/**
 * Applies `fn` to every key and string leaf of a JSON value. Booleans and null are untouched.
 * Numbers are untouched too, except when `outbound` is set (data going to the model): there a
 * number the pseudonymizer would change, or an integer of 8+ digits, becomes a string.
 * Restore never touches numbers, so model-produced integers survive.
 */
function mapStrings(value: unknown, fn: (s: string) => string, outbound: boolean): unknown {
  if (typeof value === 'string') return fn(value)
  if (typeof value === 'number' && outbound) {
    // Numbers can carry phone numbers or ids. A number the pseudonymizer would change, or an
    // integer of 8+ digits, becomes a string (so a restored value is a string, not a number).
    const text = String(value)
    const replaced = fn(text)
    if (replaced !== text) return replaced
    return Number.isInteger(value) && text.replace(/\D/g, '').length >= 8 ? '[NUMERO]' : value
  }
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, outbound))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [fn(k), mapStrings(v, fn, outbound)]),
    )
  }
  return value
}

/**
 * Message text: if it is a JSON object, array or string (typical for tool results) it is walked so that
 * escapes and punctuation stay valid; plain text is transformed as text.
 */
function mapContent(text: string, fn: (s: string) => string, outbound: boolean): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fn(text)
  }
  if (parsed === null || (typeof parsed !== 'object' && typeof parsed !== 'string')) {
    return fn(text)
  }
  return JSON.stringify(mapStrings(parsed, fn, outbound))
}

function mapCalls(calls: ToolCall[], fn: (s: string) => string, outbound: boolean): ToolCall[] {
  return calls.map((c) => ({ ...c, arguments: mapStrings(c.arguments, fn, outbound) }))
}

function mapMessage(m: ChatMessage, fn: (s: string) => string, outbound: boolean): ChatMessage {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content === null ? null : mapContent(m.content, fn, outbound),
      ...(m.toolCalls ? { toolCalls: mapCalls(m.toolCalls, fn, outbound) } : {}),
    }
  }
  return { ...m, content: mapContent(m.content, fn, outbound) }
}

/**
 * A text to embed cut to `MAX_EMBEDDING_TEXT_CHARS` on a whole character: a pair of UTF-16
 * units (an emoji, a rare letter) on the limit goes as a whole or not at all, never half.
 */
function cutForEmbedding(text: string): string {
  if (text.length <= MAX_EMBEDDING_TEXT_CHARS) return text
  const last = text.charCodeAt(MAX_EMBEDDING_TEXT_CHARS - 1)
  const highSurrogate = last >= 0xd800 && last <= 0xdbff
  return text.slice(0, highSurrogate ? MAX_EMBEDDING_TEXT_CHARS - 1 : MAX_EMBEDDING_TEXT_CHARS)
}

/**
 * Pseudonymizes everything sent to the inner runner and restores what comes back.
 * A new `Pseudonymizer` (its own tokens) is made per `run`, from the people of the request's
 * project known at that moment; their dictionary is compiled once per list and shared. Tool specs are product-authored and passed through unchanged.
 * Composed by `createModelRunner`; not exported from the package.
 */
export function pseudonymizingRunner(
  inner: ModelRunner,
  people: (projectId: ProjectId) => Promise<KnownPerson[]>,
): ModelRunner {
  const chat: ModelRunner = {
    backend: inner.backend,
    async run(req, signal) {
      const { projectId } = req.context
      const p = new Pseudonymizer(peopleMatcherFor(projectId, await people(projectId)))
      const out = (s: string) => p.pseudonymize(s)
      // A credential (the link or the code of a meeting) is never written back in clear.
      const back = (s: string) => p.restore(s, { credentials: 'withheld' })
      const res = await inner.run(
        { ...req, messages: req.messages.map((m) => mapMessage(m, out, true)) },
        signal,
      )
      return { ...res, message: mapMessage(res.message, back, false) as typeof res.message }
    },
  }
  const { embedding, embed } = inner
  if (!embedding || !embed) return chat
  return {
    ...chat,
    embedding,
    // Texts to embed are hidden with index-free placeholders: a stored vector keeps its meaning
    // when the people list changes. The same recognizers and dictionary as the chat; then cut.
    async embed(req, signal) {
      const { projectId } = req.context
      const p = new Pseudonymizer(peopleMatcherFor(projectId, await people(projectId)), {
        placeholders: 'index-free',
      })
      const texts = req.texts.map((t) => cutForEmbedding(p.pseudonymize(t)))
      return embed.call(inner, { ...req, texts }, signal)
    },
  }
}
