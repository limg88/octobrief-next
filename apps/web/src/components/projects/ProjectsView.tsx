'use client'
import { isAdmin } from '@octobrief/domain'
import { Plus } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useProjects } from '@/lib/queries'
import { projectHref } from '../shell/navigation'
import { useSession } from '../shell/session-context'
import { CreateProjectDialog } from './CreateProjectDialog'
import { RoleBadge } from './RoleBadge'

/** Home of Studio: the projects the user can see, and «New project» (also from ⌘K). */
export function ProjectsView() {
  const t = useTranslations('projects')
  const errors = useTranslations('errors')
  const { user } = useSession()
  const projects = useProjects()
  const router = useRouter()
  const pathname = usePathname()
  const creating = useSearchParams()?.get('new') === '1'
  const setCreating = (open: boolean) => router.replace(open ? `${pathname}?new=1` : pathname)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {isAdmin(user) ? t('subtitleAdmin') : t('subtitle')}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> {t('new')}
        </Button>
      </header>

      {projects.isError && <p className="text-sm text-destructive">{errors('generic')}</p>}
      {projects.data?.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      )}
      <ul className="grid gap-2">
        {projects.data?.map((project) => (
          <li key={project.id}>
            <Link
              href={projectHref(project.slug)}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 hover:bg-accent"
            >
              <span className="font-medium">{project.name}</span>
              {project.client && (
                <span className="text-sm text-muted-foreground">{project.client}</span>
              )}
              <span className="ml-auto">
                <RoleBadge role={project.memberRole} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}
