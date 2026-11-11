import { describe, expect, it } from 'vitest'
import { ConfigError, loadWebConfig, loadWorkerConfig } from '../src/config.ts'

const WEB_ENV = {
  DATABASE_URL: 'postgres://app@localhost/db',
  PUBLIC_URL: 'https://octobrief.example.test/some/path',
  OIDC_ISSUER: 'https://login.microsoftonline.com/tenant/v2.0',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret-value',
  ADMIN_EMAILS: ' Alba@Example.test, ,bob@example.test',
}

describe('web config', () => {
  it('reads database, public origin, issuer and admin emails', () => {
    const config = loadWebConfig(WEB_ENV)
    expect(config.databaseUrl).toBe('postgres://app@localhost/db')
    expect(config.publicUrl).toBe('https://octobrief.example.test')
    expect(config.secureCookies).toBe(true)
    expect(config.oidc).toEqual({
      issuer: WEB_ENV.OIDC_ISSUER,
      clientId: 'client',
      clientSecret: 'secret-value',
      allowInsecureIssuer: false,
    })
    expect([...config.adminEmails]).toEqual(['alba@example.test', 'bob@example.test'])
  })

  it('allows an insecure issuer on loopback only', () => {
    const local = loadWebConfig({
      ...WEB_ENV,
      PUBLIC_URL: 'http://127.0.0.1:3310',
      OIDC_ISSUER: 'http://127.0.0.1:4320',
      OIDC_ALLOW_INSECURE_ISSUER: 'true',
    })
    expect(local.oidc.allowInsecureIssuer).toBe(true)
    expect(local.secureCookies).toBe(false)
    expect(() => loadWebConfig({ ...WEB_ENV, OIDC_ALLOW_INSECURE_ISSUER: 'true' })).toThrow(
      /OIDC_ALLOW_INSECURE_ISSUER/,
    )
  })

  it('names the missing keys without echoing values', () => {
    let error: unknown
    try {
      loadWebConfig({ ...WEB_ENV, DATABASE_URL: 'mysql://secret@host', OIDC_CLIENT_SECRET: '' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect(String(error)).toMatch(/DATABASE_URL, OIDC_CLIENT_SECRET/)
    expect(String(error)).not.toMatch(/secret@host/)
  })
})

describe('worker config', () => {
  it('reads the worker database URL', () => {
    const config = loadWorkerConfig({ DATABASE_WORKER_URL: 'postgresql://worker@localhost/db' })
    expect(config.databaseUrl).toBe('postgresql://worker@localhost/db')
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_WORKER_URL/)
  })
})
