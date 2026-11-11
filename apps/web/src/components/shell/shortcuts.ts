import { type NavEntry, projectEntries } from './navigation.ts'

/** How long after «G» the second key still counts. */
export const CHORD_WINDOW_MS = 1000
const TEXT_FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export interface KeyInput {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  /** Focus is in a text field: single-letter shortcuts do not apply there. */
  typing: boolean
  now: number
}

export type ShortcutAction = { type: 'palette' } | { type: 'navigate'; href: string } | null

export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return element !== null && (element.isContentEditable || TEXT_FIELDS.has(element.tagName))
}

/**
 * Linear-like shortcuts: ⌘K / Ctrl+K opens the palette; «G» then a section key navigates inside
 * the current project. Keeps the time of the last «G» between calls.
 */
export function createShortcutTracker(getSlug: () => string | null) {
  let lastG = Number.NEGATIVE_INFINITY

  return function handle(input: KeyInput): ShortcutAction {
    const key = input.key.toLowerCase()
    if ((input.meta || input.ctrl) && key === 'k') return { type: 'palette' }
    if (input.meta || input.ctrl || input.alt || input.typing) return null
    if (key === 'g') {
      lastG = input.now
      return null
    }
    const inChord = input.now - lastG < CHORD_WINDOW_MS
    lastG = Number.NEGATIVE_INFINITY
    const slug = getSlug()
    if (!inChord || !slug) return null
    const entry: NavEntry | undefined = projectEntries(slug).find((e) => e.key === key)
    return entry ? { type: 'navigate', href: entry.href } : null
  }
}
