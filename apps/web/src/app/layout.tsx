import type { ReactNode } from 'react'

export const metadata = { title: 'Octobrief' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>{children}</body>
    </html>
  )
}
