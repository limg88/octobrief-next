import { LOCALE_COOKIE } from '@octobrief/api/cookies'
import { DEFAULT_LOCALE, isLocale } from '@octobrief/domain'
import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

// The language comes from the user's preference, mirrored in a cookie at login and on change.
export default getRequestConfig(async () => {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value
  const locale = isLocale(stored) ? stored : DEFAULT_LOCALE
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default }
})
