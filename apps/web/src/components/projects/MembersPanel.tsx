'use client'
import { canManageMembers, isAdmin, type MemberRole } from '@octobrief/domain'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAddMember, useMembers } from '@/lib/queries'
import { useSession } from '../shell/session-context'
import { errorKey } from './error-message'
import { RoleBadge } from './RoleBadge'

const ADD_ERRORS = ['notFound', 'conflict', 'forbidden'] as const
const CODE_TO_KEY: Record<string, (typeof ADD_ERRORS)[number]> = {
  not_found: 'notFound',
  conflict: 'conflict',
  forbidden: 'forbidden',
}

export function MembersPanel({
  slug,
  viewerRole,
}: {
  slug: string
  viewerRole: MemberRole | null
}) {
  const t = useTranslations('members')
  const errors = useTranslations('errors')
  const { user } = useSession()
  const members = useMembers(slug)
  const add = useAddMember(slug)
  const [email, setEmail] = useState('')
  const canManage = canManageMembers(viewerRole, isAdmin(user))
  const code = errorKey(add.error, Object.keys(CODE_TO_KEY))

  function submit(event: FormEvent) {
    event.preventDefault()
    add.mutate(email, {
      onSuccess: () => {
        toast.success(t('added'))
        setEmail('')
      },
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{t('title')}</h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {members.data?.map((member) => (
          <li key={member.userId} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="font-medium">{member.displayName}</span>
            <span className="text-muted-foreground">{member.email}</span>
            <span className="ml-auto">
              <RoleBadge role={member.role} />
            </span>
          </li>
        ))}
      </ul>
      {canManage ? (
        <form onSubmit={submit} className="flex gap-2">
          <Input
            type="email"
            required
            value={email}
            placeholder={t('email')}
            aria-label={t('email')}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={add.isPending}>
            {t('add')}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">{t('onlyOwners')}</p>
      )}
      {add.isError && (
        <p role="alert" className="text-sm text-destructive">
          {code ? t(CODE_TO_KEY[code] as (typeof ADD_ERRORS)[number]) : errors('generic')}
        </p>
      )}
    </section>
  )
}
