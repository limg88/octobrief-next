'use client'
import type { Locale } from '@octobrief/domain'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { useChangeLocale } from '@/lib/queries'

/** Theme and language switches shared by the user menu and the command palette. */
export function usePreferences() {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const changeLocale = useChangeLocale()
  const t = useTranslations('errors')

  return {
    theme: resolvedTheme,
    setTheme,
    toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
    setLocale: (locale: Locale) =>
      changeLocale.mutate(locale, {
        // The language is read on the server: refresh the rendered pages.
        onSuccess: () => router.refresh(),
        onError: () => toast.error(t('generic')),
      }),
  }
}
