import { render } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { Providers } from '@/components/providers'
import { type ClientSession, SessionProvider } from '@/components/shell/session-context'
import type { ProjectDto, SessionUser } from '@/lib/api-types'
import messages from '../../messages/it.json'

export const PAOLA: SessionUser = {
  id: 'u-paola',
  displayName: 'Paola Prova',
  email: 'paola.prova@example.test',
  role: 'pm',
  locale: 'it',
}

export const ALPHA: ProjectDto = {
  id: 'p-1',
  slug: 'alpha',
  name: 'Alpha',
  client: 'ACME',
  createdAt: '2026-11-11T10:00:00.000Z',
  memberRole: 'owner',
}

export type Handler = (init: RequestInit) => Response | Promise<Response>

/** Stubs `fetch` with `METHOD /api/path` handlers; records every call. */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: { key: string; init: RequestInit }[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`
    calls.push({ key, init })
    const handler = handlers[key]
    return handler ? handler(init) : Response.json({ error: 'not_found' }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

export function renderWithProviders(
  ui: ReactNode,
  session: ClientSession = { user: PAOLA, csrfToken: 'csrf-1' },
) {
  return render(
    <NextIntlClientProvider locale="it" messages={messages} timeZone="Europe/Rome">
      <Providers>
        <SessionProvider value={session}>{ui}</SessionProvider>
      </Providers>
    </NextIntlClientProvider>,
  )
}
