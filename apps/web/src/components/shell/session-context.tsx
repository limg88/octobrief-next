'use client'
import { createContext, type ReactNode, useContext } from 'react'
import type { SessionUser } from '@/lib/api-types'

export interface ClientSession {
  user: SessionUser
  csrfToken: string
}

const SessionContext = createContext<ClientSession | null>(null)

export function SessionProvider({
  value,
  children,
}: {
  value: ClientSession
  children: ReactNode
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): ClientSession {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionProvider')
  return session
}
