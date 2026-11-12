import { describe, expect, it } from 'vitest'
import {
  currentPhase,
  DomainError,
  isTerminalPhase,
  MAX_QUESTION_LENGTH,
  parseQuestionText,
  QUESTION_PHASES,
} from '../src/recipe/index.ts'

describe('question text', () => {
  it('is kept in its canonical form', () => {
    expect(parseQuestionText('  Qual è lo​ stato\n\n del   collaudo? ')).toBe(
      'Qual è lo stato del collaudo?',
    )
  })

  it('refuses a question that is empty once invisible characters and spaces are removed', () => {
    for (const blank of ['', '   ', '​‍\n']) {
      expect(() => parseQuestionText(blank)).toThrow(DomainError)
    }
    try {
      parseQuestionText(' ')
    } catch (e) {
      expect((e as DomainError).code).toBe('question_text_invalid')
    }
  })

  it('accepts up to the limit and refuses one character more, counted after trimming', () => {
    expect(parseQuestionText(`  ${'a'.repeat(MAX_QUESTION_LENGTH)}  `)).toHaveLength(
      MAX_QUESTION_LENGTH,
    )
    expect(() => parseQuestionText('a'.repeat(MAX_QUESTION_LENGTH + 1))).toThrow(DomainError)
  })

  it('counts characters, not code units', () => {
    expect(parseQuestionText('😀'.repeat(MAX_QUESTION_LENGTH))).toHaveLength(
      MAX_QUESTION_LENGTH * 2,
    )
  })
})

describe('question phase', () => {
  it('lists the phases in order', () => {
    expect(QUESTION_PHASES).toEqual(['queued', 'reading', 'checking', 'done', 'failed'])
  })

  it('is the furthest phase reached, whatever order the events come in', () => {
    expect(currentPhase(['queued'])).toBe('queued')
    expect(currentPhase(['checking', 'queued', 'reading'])).toBe('checking')
    expect(currentPhase(['queued', 'reading', 'done'])).toBe('done')
    expect(currentPhase(['queued', 'failed', 'reading'])).toBe('failed')
  })

  it('without any event is queued', () => {
    expect(currentPhase([])).toBe('queued')
  })

  it('done and failed are terminal', () => {
    expect(QUESTION_PHASES.filter(isTerminalPhase)).toEqual(['done', 'failed'])
  })
})
