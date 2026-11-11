import { ApplicationError, type IdentityProvider, type PendingLogin } from '@octobrief/application'
import * as oidc from 'openid-client'
import { describeLoginFailure, identityFromClaims } from './claims.ts'

export interface OidcSettings {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  /** Plain HTTP issuer, allowed only for the local fake issuer. */
  readonly allowInsecureIssuer: boolean
  readonly callbackUrl: string
  readonly postLogoutUrl: string
}

const SCOPE = 'openid profile email'
const LOGOUT_DISCOVERY_TIMEOUT_MS = 3000

/** Entra ID (or any OpenID Connect issuer): authorization code with PKCE, nonce and state. */
export function createOidcIdentityProvider(settings: OidcSettings): IdentityProvider {
  let discovered: Promise<oidc.Configuration> | undefined

  function configuration(): Promise<oidc.Configuration> {
    if (!discovered) {
      const pending = oidc.discovery(
        new URL(settings.issuer),
        settings.clientId,
        undefined,
        oidc.ClientSecretPost(settings.clientSecret),
        settings.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      // A failed discovery is not remembered: the next login tries again.
      pending.catch(() => {
        discovered = undefined
      })
      discovered = pending
    }
    return discovered
  }

  return {
    async begin({ loginHint }) {
      const config = await configuration()
      const pending: PendingLogin = {
        codeVerifier: oidc.randomPKCECodeVerifier(),
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
      }
      const params: Record<string, string> = {
        redirect_uri: settings.callbackUrl,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: await oidc.calculatePKCECodeChallenge(pending.codeVerifier),
        code_challenge_method: 'S256',
        state: pending.state,
        nonce: pending.nonce,
      }
      if (loginHint) params.login_hint = loginHint
      return { authorizationUrl: oidc.buildAuthorizationUrl(config, params).toString(), pending }
    },

    async complete(callbackQuery, pending) {
      try {
        const config = await configuration()
        // Rebuilt from the configured callback so redirect_uri matches behind proxies.
        const current = new URL(settings.callbackUrl)
        current.search = callbackQuery
        const tokens = await oidc.authorizationCodeGrant(config, current, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        })
        const claims = tokens.claims()
        if (!claims) throw new Error('token response without ID token')
        return identityFromClaims(claims, settings.issuer)
      } catch (error) {
        throw new ApplicationError('login_failed', describeLoginFailure(error), { cause: error })
      }
    },

    async logoutUrl() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('discovery timed out')),
          LOGOUT_DISCOVERY_TIMEOUT_MS,
        )
      })
      try {
        const config = await Promise.race([configuration(), late])
        if (!config.serverMetadata().end_session_endpoint) return settings.postLogoutUrl
        return oidc
          .buildEndSessionUrl(config, { post_logout_redirect_uri: settings.postLogoutUrl })
          .toString()
      } catch {
        // The local session is already gone: never block logout on the issuer.
        return settings.postLogoutUrl
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
