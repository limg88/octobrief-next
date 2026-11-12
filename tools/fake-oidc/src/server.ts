import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { FAKE_USERS, type FakeUser, resolveUser } from './users.ts'

export { FAKE_USERS, type FakeUser, resolveUser } from './users.ts'

export interface FakeOidcOptions {
  port?: number
  host?: string
  /** Where to listen when it differs from the issuer's host (a container that publishes the port). */
  bindHost?: string
  clientId: string
  clientSecret: string
  redirectUris: readonly string[]
}

export interface FakeOidc {
  issuer: string
  stop(): Promise<void>
}

interface PendingCode {
  user: FakeUser
  redirectUri: string
  codeChallenge: string
  nonce: string | undefined
  expiresAt: number
}

const CODE_TTL_MS = 60_000
const KEY_ID = 'fake-oidc-rs256'
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, location: URL): void {
  res.writeHead(302, { location: location.toString(), 'cache-control': 'no-store' })
  res.end()
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

/** Without `login_hint` the person is chosen on a page, as a real issuer asks who signs in. */
function choosePerson(res: ServerResponse, request: URL): void {
  const links = Object.entries(FAKE_USERS)
    .map(([key, user]) => {
      const next = new URL(request)
      next.searchParams.set('login_hint', key)
      return `<li><a href="${escapeHtml(next.pathname + next.search)}">${escapeHtml(user.name)}</a> <small>${escapeHtml(user.email)}</small></li>`
    })
    .join('')
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Accesso di prova</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}li{margin:.75rem 0}a{font-size:1.1rem}small{display:block;opacity:.7}</style></head><body><h1>Accesso di prova</h1><p>Scegli con quale persona sintetica entrare.</p><ul>${links}</ul></body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * A minimal OpenID Connect issuer for tests and local development: discovery, authorization code
 * with PKCE S256, token, JWKS and logout. The person comes from `login_hint`. Never in production.
 */
export async function startFakeOidc(options: FakeOidcOptions): Promise<FakeOidc> {
  const host = options.host ?? '127.0.0.1'
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }
  const codes = new Map<string, PendingCode>()
  const logoutOrigins = new Set(options.redirectUris.map((uri) => new URL(uri).origin))
  let issuer = ''

  function authorize(url: URL, res: ServerResponse): void {
    const p = url.searchParams
    const redirectUri = p.get('redirect_uri') ?? ''
    // Without a trusted client and redirect URI nothing may be sent back.
    if (p.get('client_id') !== options.clientId || !options.redirectUris.includes(redirectUri)) {
      send(res, 400, { error: 'invalid_request' })
      return
    }
    const back = new URL(redirectUri)
    const state = p.get('state')
    if (state !== null) back.searchParams.set('state', state)
    back.searchParams.set('iss', issuer)
    const challenge = p.get('code_challenge')
    const scopes = (p.get('scope') ?? '').split(' ')
    if (
      p.get('response_type') !== 'code' ||
      !scopes.includes('openid') ||
      p.get('code_challenge_method') !== 'S256' ||
      !challenge
    ) {
      back.searchParams.set('error', 'invalid_request')
      redirect(res, back)
      return
    }
    const hint = p.get('login_hint')
    if (hint === null || hint.trim() === '') {
      choosePerson(res, url)
      return
    }
    const user = resolveUser(hint)
    if (!user) {
      back.searchParams.set('error', 'access_denied')
      redirect(res, back)
      return
    }
    const code = randomBytes(24).toString('base64url')
    codes.set(code, {
      user,
      redirectUri,
      codeChallenge: challenge,
      nonce: p.get('nonce') ?? undefined,
      expiresAt: Date.now() + CODE_TTL_MS,
    })
    back.searchParams.set('code', code)
    redirect(res, back)
    return
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req)
    const id = form.get('client_id')
    const secret = form.get('client_secret')
    if (id !== options.clientId || !secret || !sameSecret(secret, options.clientSecret)) {
      return send(res, 401, { error: 'invalid_client' })
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return send(res, 400, { error: 'unsupported_grant_type' })
    }
    const code = form.get('code') ?? ''
    const pending = codes.get(code)
    codes.delete(code)
    const verifier = form.get('code_verifier') ?? ''
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      pending.redirectUri !== form.get('redirect_uri') ||
      verifier === '' ||
      challenge !== pending.codeChallenge
    ) {
      return send(res, 400, { error: 'invalid_grant' })
    }
    const { user } = pending
    const idToken = await new SignJWT({
      oid: user.oid,
      name: user.name,
      email: user.email,
      preferred_username: user.email,
      ...(pending.nonce !== undefined ? { nonce: pending.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(options.clientId)
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
    return send(res, 200, {
      access_token: randomBytes(24).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    })
  }

  function logout(url: URL, res: ServerResponse): void {
    const back = url.searchParams.get('post_logout_redirect_uri')
    if (back === null) {
      send(res, 200, { signed_out: true })
      return
    }
    // A destination that is not the client's is never followed (open redirect).
    if (!URL.canParse(back) || !logoutOrigins.has(new URL(back).origin)) {
      send(res, 400, { error: 'invalid_request' })
      return
    }
    redirect(res, new URL(back))
    return
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', issuer)
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /.well-known/openid-configuration') {
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email'],
      })
    }
    if (route === 'GET /jwks') return send(res, 200, { keys: [jwk] })
    if (route === 'GET /authorize') return authorize(url, res)
    if (route === 'POST /token') return token(req, res)
    if (route === 'GET /logout') return logout(url, res)
    return send(res, 404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'server_error' })
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.bindHost ?? host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  issuer = `http://${host}:${port}`

  return {
    issuer,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
