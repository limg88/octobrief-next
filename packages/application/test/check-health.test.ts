import { describe, expect, it } from 'vitest'
import { checkHealth } from '../src/use-cases/check-health.ts'

const probe = (name: string, check: () => Promise<boolean>) => ({ name, check })

describe('checkHealth', () => {
  it('reports up when every probe answers true', async () => {
    const report = await checkHealth([
      probe('database', async () => true),
      probe('queue', async () => true),
    ])
    expect(report).toEqual({
      status: 'up',
      components: [
        { name: 'database', status: 'up' },
        { name: 'queue', status: 'up' },
      ],
    })
  })

  it('counts a throwing probe as down', async () => {
    const report = await checkHealth([
      probe('database', async () => {
        throw new Error('unreachable')
      }),
    ])
    expect(report.status).toBe('down')
  })

  it('counts a probe answering false as down', async () => {
    const report = await checkHealth([probe('queue', async () => false)])
    expect(report.components[0]?.status).toBe('down')
  })

  it('counts a slow probe as down', async () => {
    const never = probe('slow', () => new Promise<boolean>(() => {}))
    const report = await checkHealth([never], 10)
    expect(report.status).toBe('down')
  })
})
