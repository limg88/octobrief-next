import { describe, expect, it } from 'vitest'
import { isFinished } from '../src/job-status.ts'

describe('isFinished', () => {
  it.each([
    ['queued', false],
    ['running', false],
    ['completed', true],
    ['failed', true],
  ] as const)('%s -> %s', (status, expected) => {
    expect(isFinished(status)).toBe(expected)
  })
})
