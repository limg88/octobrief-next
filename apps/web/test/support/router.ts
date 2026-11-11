import { vi } from 'vitest'

/** The `next/navigation` router the components see in tests. */
export const router = {
  pathname: '/',
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
}

export function resetRouter(pathname = '/'): void {
  router.pathname = pathname
  for (const fn of [router.push, router.replace, router.refresh]) fn.mockReset()
}
