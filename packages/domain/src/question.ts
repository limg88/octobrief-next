import { canonicalText } from './canonical.ts'
import { DomainError } from './errors.ts'

/** Where a question of the PM is: written down, read by the model, checked, answered or failed. */
export const QUESTION_PHASES = ['queued', 'reading', 'checking', 'done', 'failed'] as const
export type QuestionPhase = (typeof QUESTION_PHASES)[number]

/** Longest question, in characters (code points) of its canonical form. */
export const MAX_QUESTION_LENGTH = 2000

const RANK: Readonly<Record<QuestionPhase, number>> = {
  queued: 0,
  reading: 1,
  checking: 2,
  done: 3,
  failed: 3,
}

export function isTerminalPhase(phase: QuestionPhase): boolean {
  return phase === 'done' || phase === 'failed'
}

/**
 * The phase of a question from its events (stored insert-only, one per phase): the furthest one
 * reached; a terminal phase wins. No event at all means it is still queued.
 */
export function currentPhase(events: readonly QuestionPhase[]): QuestionPhase {
  let phase: QuestionPhase = 'queued'
  for (const e of events) {
    if (isTerminalPhase(phase)) break
    if (RANK[e] > RANK[phase] || isTerminalPhase(e)) phase = e
  }
  return phase
}

/** The text of a question in its canonical form: 1 to `MAX_QUESTION_LENGTH` characters. */
export function parseQuestionText(raw: string): string {
  const text = canonicalText(raw)
  if (text === '' || [...text].length > MAX_QUESTION_LENGTH) {
    throw new DomainError('question_text_invalid')
  }
  return text
}
