import { describe, expect, it } from 'vitest'
import {
  CHORD_WINDOW_MS,
  createShortcutTracker,
  isTyping,
} from '../src/components/shell/shortcuts.ts'

const key = (
  k: string,
  now: number,
  extra: Partial<Parameters<ReturnType<typeof createShortcutTracker>>[0]> = {},
) => ({
  key: k,
  meta: false,
  ctrl: false,
  alt: false,
  typing: false,
  now,
  ...extra,
})

describe('shortcuts', () => {
  it('opens the palette with ⌘K or Ctrl+K, even while typing', () => {
    const handle = createShortcutTracker(() => null)
    expect(handle(key('k', 0, { meta: true, typing: true }))).toEqual({ type: 'palette' })
    expect(handle(key('K', 0, { ctrl: true }))).toEqual({ type: 'palette' })
  })

  it('navigates with G then a section key inside a project', () => {
    const handle = createShortcutTracker(() => 'alpha')
    expect(handle(key('g', 0))).toBeNull()
    expect(handle(key('m', 500))).toEqual({ type: 'navigate', href: '/projects/alpha/memory' })
    expect(handle(key('m', 600))).toBeNull()
  })

  it('ignores late keys, unknown keys, modifiers, typing and pages outside projects', () => {
    const handle = createShortcutTracker(() => 'alpha')
    handle(key('g', 0))
    expect(handle(key('c', CHORD_WINDOW_MS))).toBeNull()
    handle(key('g', 0))
    expect(handle(key('x', 10))).toBeNull()
    handle(key('g', 0))
    expect(handle(key('c', 10, { alt: true }))).toBeNull()
    expect(handle(key('g', 0, { typing: true }))).toBeNull()
    const outside = createShortcutTracker(() => null)
    outside(key('g', 0))
    expect(outside(key('c', 10))).toBeNull()
  })

  it('detects text fields', () => {
    expect(isTyping(null)).toBe(false)
    expect(isTyping({ tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget)).toBe(
      true,
    )
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    )
    expect(isTyping({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(
      false,
    )
  })
})
