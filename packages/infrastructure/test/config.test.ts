import { describe, expect, it } from 'vitest'
import { ConfigError, loadWebConfig, loadWorkerConfig } from '../src/config.ts'

const WEB_ENV = {
  DATABASE_URL: 'postgres://app@localhost/db',
  PUBLIC_URL: 'https://octobrief.example.test/some/path',
  OIDC_ISSUER: 'https://login.microsoftonline.com/tenant/v2.0',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret-value',
  ADMIN_EMAILS: ' Alba@Example.test, ,bob@example.test',
  BLOB_DIR: '/var/lib/octobrief/blobs',
  SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  RECIPES_DIR: '/srv/octobrief/recipes',
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
    expect(config.blobDir).toBe('/var/lib/octobrief/blobs')
  })

  it('wants an absolute blob directory', () => {
    expect(() => loadWebConfig({ ...WEB_ENV, BLOB_DIR: '.data/blobs' })).toThrow(/BLOB_DIR/)
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
  const WORKER_ENV = {
    DATABASE_WORKER_URL: 'postgresql://worker@localhost/db',
    BLOB_DIR: '/var/lib/octobrief/blobs',
    SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    RECIPES_DIR: '/srv/octobrief/recipes',
    TEMPLATES_DIR: '/srv/octobrief/templates',
  }

  it('treats a key set to nothing as not set (compose passes optional keys empty)', () => {
    const env = {
      ...WORKER_ENV,
      LLM_API_URL: '',
      LLM_API_TOKEN: '',
      LLM_MODEL: '',
      RENDERER_URL: '',
    }
    expect(loadWorkerConfig(env)).toEqual(loadWorkerConfig(WORKER_ENV))
  })

  it('reads database URL, blob directory and retention with its default', () => {
    expect(loadWorkerConfig(WORKER_ENV)).toEqual({
      databaseUrl: 'postgresql://worker@localhost/db',
      blobDir: '/var/lib/octobrief/blobs',
      retentionDays: 365,
      model: { chat: { backend: 'fake' }, embedding: { backend: 'fake' } },
      syncIntervalMinutes: 15,
      recipesDir: '/srv/octobrief/recipes',
      templatesDir: '/srv/octobrief/templates',
      sources: {
        secretsKey: expect.objectContaining({ version: 1 }),
        devEndpoints: {},
        syncFoldersRoot: null,
      },
    })
    expect(loadWorkerConfig({ ...WORKER_ENV, RETENTION_DAYS: '30' }).retentionDays).toBe(30)
    expect(() => loadWorkerConfig({ ...WORKER_ENV, RETENTION_DAYS: '0' })).toThrow(/RETENTION_DAYS/)
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_WORKER_URL/)
  })

  it('wants a real secrets key and accepts fake source systems on loopback only', () => {
    expect(() => loadWorkerConfig({ ...WORKER_ENV, SECRETS_KEY: 'too-short' })).toThrow(
      'SECRETS_KEY',
    )
    expect(() =>
      loadWorkerConfig({ ...WORKER_ENV, SOURCES_DEV_JIRA_URL: 'https://jira.example.com' }),
    ).toThrow('SOURCES_DEV_JIRA_URL')
    const config = loadWorkerConfig({
      ...WORKER_ENV,
      SOURCES_DEV_JIRA_URL: 'http://127.0.0.1:4330',
      SOURCES_DEV_ADO_URL: 'http://127.0.0.1:4331',
      SYNC_INTERVAL_MINUTES: '5',
      SYNC_FOLDERS_ROOT: '/srv/octobrief/sync',
    })
    expect(config.syncIntervalMinutes).toBe(5)
    expect(config.sources.syncFoldersRoot).toBe('/srv/octobrief/sync')
    expect(config.sources.devEndpoints).toEqual({
      jira: 'http://127.0.0.1:4330',
      ado: 'http://127.0.0.1:4331',
    })
  })
})
