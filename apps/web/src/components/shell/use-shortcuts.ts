'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { createShortcutTracker, isTyping } from './shortcuts'

/** Wires the global keyboard shortcuts to the router and the command palette. */
export function useShortcuts(slug: string | null, openPalette: () => void): void {
  const router = useRouter()
  const slugRef = useRef(slug)
  slugRef.current = slug

  useEffect(() => {
    const handle = createShortcutTracker(() => slugRef.current)
    function onKey(event: KeyboardEvent) {
      const action = handle({
        key: event.key,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        typing: isTyping(event.target),
        now: Date.now(),
      })
      if (!action) return
      event.preventDefault()
      if (action.type === 'palette') openPalette()
      else router.push(action.href)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPalette, router])
}
