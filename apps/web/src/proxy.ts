import { type NextRequest, NextResponse } from 'next/server'

/** Exposes the requested path to server layouts (used to come back after login). */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] }
