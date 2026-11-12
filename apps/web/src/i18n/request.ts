import { LOCALE_COOKIE } from '@octobrief/api/cookies'
import { DEFAULT_LOCALE, isLocale, PRODUCT_TIME_ZONE } from '@octobrief/domain'
import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

// The language comes from the user's preference, mirrored in a cookie at login and on change.
export default getRequestConfig(async () => {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value
  const locale = isLocale(stored) ? stored : DEFAULT_LOCALE
  return {
    locale,
    // Dates are days in Italy: without this a server in UTC shows midnight as the day before.
    timeZone: PRODUCT_TIME_ZONE,
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
