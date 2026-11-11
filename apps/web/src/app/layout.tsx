import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import { Providers } from '@/components/providers'
import { monaSans } from '../font/mona-sans'
import './globals.css'

export const metadata: Metadata = { title: 'Octobrief' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={await getLocale()} className={monaSans.variable} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
