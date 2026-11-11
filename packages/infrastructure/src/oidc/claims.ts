import type { LoginIdentity } from '@octobrief/application'

type Claims = Record<string, unknown>

function claimString(claims: Claims, name: string): string | undefined {
  const value = claims[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An issuer as compared: lower-cased host and path, no trailing slash; null if not a URL. */
function issuerKey(issuer: unknown): string | null {
  if (typeof issuer !== 'string' || !URL.canParse(issuer)) return null
  const url = new URL(issuer)
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`
}

export class InvalidClaimsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidClaimsError'
  }
}

/**
 * Maps ID token claims to an identity. Entra's stable per-tenant id is `oid` (`sub` is pairwise
 * per application), qualified by the issuer so two tenants never share a user. The email is
 * trusted only from the configured issuer when it equals the UPN (never a guest `#EXT#`) or the
 * tenant marks it verified (`xms_edov`): this blocks the nOAuth email takeover.
 */
export function identityFromClaims(claims: Claims, configuredIssuer: string): LoginIdentity {
  const issuer = claimString(claims, 'iss')
  const subject = claimString(claims, 'oid') ?? claimString(claims, 'sub')
  if (!issuer || !subject) throw new InvalidClaimsError('ID token without issuer or subject')
  const preferred = claimString(claims, 'preferred_username')
  const upn = preferred?.includes('@') ? preferred.toLowerCase() : null
  const email = (claimString(claims, 'email') ?? upn ?? null)?.toLowerCase() ?? null
  const displayName = claimString(claims, 'name') ?? preferred ?? email
  if (!displayName) throw new InvalidClaimsError('ID token without a usable name')
  const ownTenant = issuerKey(issuer) !== null && issuerKey(issuer) === issuerKey(configuredIssuer)
  const trustedUpn = ownTenant && upn !== null && !upn.includes('#ext#') ? upn : null
  const emailVerified =
    ownTenant && email !== null && (email === trustedUpn || claims.xms_edov === true)
  return { externalSubject: `${issuer}|${subject}`, displayName, email, emailVerified }
}

const MAX_LOG_LINE = 1000

/**
 * Error names, codes and messages only, never tokens. Control characters become spaces so remote
 * text cannot forge log lines.
 */
export function describeLoginFailure(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code
    parts.push(`${current.name}${typeof code === 'string' ? `[${code}]` : ''}: ${current.message}`)
    current = current.cause
  }
  const line = parts.length > 0 ? parts.join(' <- ') : 'unknown error'
  return line
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .slice(0, MAX_LOG_LINE)
}
