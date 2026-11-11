import { type FakeOidc, startFakeOidc } from '@octobrief/fake-oidc'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOidcIdentityProvider } from '../src/oidc/openid-identity-provider.ts'

const CALLBACK = 'http://127.0.0.1:3999/api/auth/callback'
const HOME = 'http://127.0.0.1:3999/'

/** Follows the issuer's redirect the way a browser would, returning the callback query. */
async function authorize(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'manual' })
  return new URL(res.headers.get('location') as string).search
}

describe('OpenID Connect identity provider against the fake issuer', () => {
  let fake: FakeOidc

  beforeAll(async () => {
    fake = await startFakeOidc({ clientId: 'c', clientSecret: 's', redirectUris: [CALLBACK] })
  })

  afterAll(async () => {
    await fake.stop()
  })

  function provider(issuer = fake.issuer) {
    return createOidcIdentityProvider({
      issuer,
      clientId: 'c',
      clientSecret: 's',
      allowInsecureIssuer: true,
      callbackUrl: CALLBACK,
      postLogoutUrl: HOME,
    })
  }

  it('completes the authorization code flow with PKCE', async () => {
    const idp = provider()
    const { authorizationUrl, pending } = await idp.begin({ loginHint: 'paola' })
    expect(authorizationUrl).toContain('login_hint=paola')
    const identity = await idp.complete(await authorize(authorizationUrl), pending)
    expect(identity).toEqual({
      externalSubject: `${fake.issuer}|6f1d1c52-6c1e-4d2a-9a51-1b8a4c2f0a01`,
      displayName: 'Paola Prova',
      email: 'paola.prova@example.test',
      emailVerified: true,
    })
  })

  it('shows the person chooser without a hint', async () => {
    const { authorizationUrl } = await provider().begin({ loginHint: null })
    const res = await fetch(authorizationUrl)
    expect(await res.text()).toContain('Accesso di prova')
  })

  it('fails with login_failed on a tampered state or a denied login', async () => {
    const idp = provider()
    const { authorizationUrl, pending } = await idp.begin({ loginHint: 'paola' })
    const query = await authorize(authorizationUrl)
    await expect(idp.complete(query, { ...pending, state: 'other' })).rejects.toMatchObject({
      code: 'login_failed',
    })
    const denied = await idp.begin({ loginHint: 'nobody' })
    await expect(
      idp.complete(await authorize(denied.authorizationUrl), denied.pending),
    ).rejects.toMatchObject({ code: 'login_failed' })
  })

  it('logs out at the issuer, or locally when the issuer is unreachable', async () => {
    expect(await provider().logoutUrl()).toContain(`${fake.issuer}/logout`)
    expect(await provider('http://127.0.0.1:1').logoutUrl()).toBe(HOME)
  })
})
