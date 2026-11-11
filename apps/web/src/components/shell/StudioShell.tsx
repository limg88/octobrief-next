'use client'
import { usePathname } from 'next/navigation'
import { type ReactNode, useCallback, useState } from 'react'
import { CommandPalette } from './CommandPalette'
import { slugFromPath } from './navigation'
import { SideBar } from './SideBar'
import { type ClientSession, SessionProvider } from './session-context'
import { useShortcuts } from './use-shortcuts'

/** Studio layout: sidebar, main area, ⌘K palette and keyboard shortcuts. */
export function StudioShell({
  session,
  children,
}: {
  session: ClientSession
  children: ReactNode
}) {
  const slug = slugFromPath(usePathname() ?? '/')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  useShortcuts(slug, openPalette)

  return (
    <SessionProvider value={session}>
      <div className="flex h-screen overflow-hidden">
        <SideBar slug={slug} onSearch={openPalette} />
        <main className="flex-1 overflow-y-auto px-8 py-6">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} slug={slug} />
    </SessionProvider>
  )
}
