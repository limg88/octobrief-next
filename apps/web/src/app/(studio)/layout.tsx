import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { StudioShell } from '@/components/shell/StudioShell'
import { currentSession } from '../../server/session'

export const dynamic = 'force-dynamic'

/** Studio area: without a session the server sends the browser to the login page. */
export default async function StudioLayout({ children }: { children: ReactNode }) {
  const session = await currentSession()
  if (!session) {
    const path = (await headers()).get('x-pathname') ?? '/'
    redirect(`/login?${new URLSearchParams({ return_to: path })}`)
  }
  return (
    <StudioShell session={{ user: session.user, csrfToken: session.csrfToken }}>
      {children}
    </StudioShell>
  )
}
