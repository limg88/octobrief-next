'use client'
import type { MemberRole } from '@octobrief/domain'
import { useTranslations } from 'next-intl'

const ROLE_LABELS = { owner: 'roleOwner', member: 'roleMember' } as const

export function RoleBadge({ role }: { role: MemberRole | null }) {
  const t = useTranslations('projects')
  return (
    <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {role ? t(ROLE_LABELS[role]) : t('roleAdmin')}
    </span>
  )
}
