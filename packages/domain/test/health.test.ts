import { describe, expect, it } from 'vitest'
import { summarizeHealth } from '../src/health.ts'

describe('summarizeHealth', () => {
  it('is up when every component is up', () => {
    const report = summarizeHealth([
      { name: 'database', status: 'up' },
      { name: 'queue', status: 'up' },
    ])
    expect(report.status).toBe('up')
  })

  it('is down when any component is down', () => {
    const report = summarizeHealth([
      { name: 'database', status: 'up' },
      { name: 'queue', status: 'down' },
    ])
    expect(report.status).toBe('down')
    expect(report.components).toHaveLength(2)
  })

  it('is down when there is nothing to check', () => {
    expect(summarizeHealth([]).status).toBe('down')
  })
})
