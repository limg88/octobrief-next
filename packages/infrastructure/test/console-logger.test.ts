import { describe, expect, it } from 'vitest'
import { createConsoleLogger } from '../src/logging/console-logger.ts'

describe('createConsoleLogger', () => {
  it('writes one JSON line per entry', () => {
    const lines: string[] = []
    const logger = createConsoleLogger(
      'worker',
      (line) => lines.push(line),
      () => new Date('2026-11-11T10:00:00Z'),
    )
    logger.info('started', { jobs: 1 })
    logger.error('failed')
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        time: '2026-11-11T10:00:00.000Z',
        level: 'info',
        component: 'worker',
        message: 'started',
        jobs: 1,
      },
      { time: '2026-11-11T10:00:00.000Z', level: 'error', component: 'worker', message: 'failed' },
    ])
  })
})
