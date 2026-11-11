/** What a login proves about a person, as told by the identity provider. */
export interface LoginIdentity {
  /** Stable id qualified by the issuer, e.g. `<issuer>|<oid>`. */
  readonly externalSubject: string
  readonly displayName: string
  readonly email: string | null
  /** True only when the issuer is the configured tenant and vouches for the email. */
  readonly emailVerified: boolean
}

/** The secrets of an authorization request, kept server side until the callback. */
export interface PendingLogin {
  readonly codeVerifier: string
  readonly state: string
  readonly nonce: string
}

export interface IdentityProvider {
  begin(input: { loginHint: string | null }): Promise<{
    authorizationUrl: string
    pending: PendingLogin
  }>
  /** Exchanges the callback for an identity; throws ApplicationError('login_failed'). */
  complete(callbackQuery: string, pending: PendingLogin): Promise<LoginIdentity>
  /** Where the browser goes to end the provider's session too. */
  logoutUrl(): Promise<string>
}
