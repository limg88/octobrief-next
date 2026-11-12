import { parseArgs } from 'node:util'
import { FAKE_USERS, startFakeOidc } from './server.ts'

const DEFAULT_PORT = '4320'

const { values } = parseArgs({
  options: { port: { type: 'string' }, bind: { type: 'string' } },
})
const port = values.port ?? (process.env.OIDC_ISSUER ? new URL(process.env.OIDC_ISSUER).port : '')

const clientId = process.env.OIDC_CLIENT_ID
const clientSecret = process.env.OIDC_CLIENT_SECRET
const publicUrl = process.env.PUBLIC_URL
if (!clientId || !clientSecret || !publicUrl) {
  console.error('fake-oidc needs OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and PUBLIC_URL')
  process.exit(1)
}

const fake = await startFakeOidc({
  port: Number(port || DEFAULT_PORT),
  ...(values.bind ? { bindHost: values.bind } : {}),
  clientId,
  clientSecret,
  redirectUris: [new URL('/api/auth/callback', publicUrl).toString()],
})
console.log(`fake-oidc issuer: ${fake.issuer}`)
console.log(`login_hint: ${Object.keys(FAKE_USERS).join(', ')} or "Name Surname|email"`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    fake.stop().finally(() => process.exit(0))
  })
}
