import 'server-only'
import { SESSION_COOKIE } from '@octobrief/api/cookies'
import { type ActiveSession, resolveSession } from '@octobrief/application'
import { cookies } from 'next/headers'
import { getContainer } from './container.ts'

/** The session of the current request, for server components; null when signed out. */
export async function currentSession(): Promise<ActiveSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const { deps } = await getContainer()
  return resolveSession(deps, token)
}
