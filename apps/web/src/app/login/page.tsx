import { sanitizeReturnTo } from '@octobrief/application'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { buttonVariants } from '@/components/ui/button'
import { currentSession } from '../../server/session'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; error?: string }>
}) {
  const params = await searchParams
  const returnTo = sanitizeReturnTo(params.return_to)
  if (await currentSession()) redirect(returnTo)
  const t = await getTranslations('login')
  const loginUrl = `/api/auth/login?${new URLSearchParams({ return_to: returnTo })}`

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-border bg-card p-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {params.error && (
          <p role="alert" className="text-sm text-destructive">
            {t('failed')}
          </p>
        )}
        {/* A plain link: the login is a chain of full-page redirects. */}
        <a href={loginUrl} className={buttonVariants({ size: 'lg' })}>
          {t('signIn')}
        </a>
      </div>
    </main>
  )
}
