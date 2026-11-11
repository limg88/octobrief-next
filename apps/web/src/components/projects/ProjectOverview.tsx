'use client'
import { useFormatter, useTranslations } from 'next-intl'
import { useProject } from '@/lib/queries'
import { MembersPanel } from './MembersPanel'
import { RoleBadge } from './RoleBadge'

export function ProjectOverview({ slug }: { slug: string }) {
  const t = useTranslations('projects')
  const format = useFormatter()
  const project = useProject(slug)

  if (project.isError) return <p className="text-sm text-muted-foreground">{t('notFound')}</p>
  if (!project.data) return null
  const { name, client, createdAt, memberRole } = project.data

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{name}</h1>
          <RoleBadge role={memberRole} />
        </div>
        <p className="text-sm text-muted-foreground">
          {client ? `${client} · ` : ''}
          {t('createdAt', { date: format.dateTime(new Date(createdAt), { dateStyle: 'long' }) })}
        </p>
      </header>
      <MembersPanel slug={slug} viewerRole={memberRole} />
    </div>
  )
}
