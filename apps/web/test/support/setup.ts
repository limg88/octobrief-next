// Component test setup: jest-dom matchers, DOM cleanup, a fake `next/navigation`, toasts as
// elements in the page, and the browser APIs jsdom lacks (Radix and next-themes use them).
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { router } from './router'

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => router.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

vi.mock('sonner', () => {
  const write = (role: 'alert' | 'status') => (text: unknown) => {
    const p = document.createElement('p')
    p.setAttribute('role', role)
    p.textContent = String(text)
    document.body.appendChild(p)
  }
  return {
    toast: Object.assign(write('status'), { success: write('status'), error: write('alert') }),
    Toaster: () => null,
  }
})

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => undefined
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => undefined

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
})
