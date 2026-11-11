import { createHash } from 'node:crypto'

export interface FakeUser {
  sub: string
  oid: string
  name: string
  email: string
}

/** Synthetic people only: never real names or addresses. */
export const FAKE_USERS: Readonly<Record<string, FakeUser>> = {
  paola: {
    sub: 'fake-sub-paola',
    oid: '6f1d1c52-6c1e-4d2a-9a51-1b8a4c2f0a01',
    name: 'Paola Prova',
    email: 'paola.prova@example.test',
  },
  marco: {
    sub: 'fake-sub-marco',
    oid: '6f1d1c52-6c1e-4d2a-9a51-1b8a4c2f0a02',
    name: 'Marco Esempio',
    email: 'marco.esempio@example.test',
  },
  admin: {
    sub: 'fake-sub-admin',
    oid: '6f1d1c52-6c1e-4d2a-9a51-1b8a4c2f0a03',
    name: 'Alba Amministratrice',
    email: 'alba.amministratrice@example.test',
  },
}

function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** A fixture key or email, or an ad hoc `name|email` person with a stable identity. */
export function resolveUser(hint: string | null): FakeUser | null {
  if (!hint) return null
  const known = Object.hasOwn(FAKE_USERS, hint) ? FAKE_USERS[hint] : undefined
  if (known) return known
  const byEmail = Object.values(FAKE_USERS).find((x) => x.email === hint.trim().toLowerCase())
  if (byEmail) return byEmail
  const separator = hint.indexOf('|')
  if (separator <= 0) return null
  const name = hint.slice(0, separator).trim()
  const email = hint
    .slice(separator + 1)
    .trim()
    .toLowerCase()
  if (name === '' || !/^[^@\s|]+@[^@\s|]+$/.test(email)) return null
  return { sub: `fake-sub-${stableUuid(email)}`, oid: stableUuid(`oid:${email}`), name, email }
}
