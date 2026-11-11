import { describe, expect, it } from 'vitest'
import { ConfigError, loadWebConfig, loadWorkerConfig } from '../src/config.ts'

describe('config', () => {
  it('reads the web database URL', () => {
    const config = loadWebConfig({ DATABASE_URL: 'postgres://app@localhost/db' })
    expect(config.databaseUrl).toBe('postgres://app@localhost/db')
  })

  it('reads the worker database URL', () => {
    const config = loadWorkerConfig({ DATABASE_WORKER_URL: 'postgresql://worker@localhost/db' })
    expect(config.databaseUrl).toBe('postgresql://worker@localhost/db')
  })

  it('names the missing keys without echoing values', () => {
    expect(() => loadWebConfig({ DATABASE_URL: 'mysql://secret@host' })).toThrow(
      new ConfigError(['DATABASE_URL']),
    )
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_WORKER_URL/)
  })
})
