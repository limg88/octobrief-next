'use client'
import { CLIENT_NAME_MAX_LENGTH, PROJECT_NAME_MAX_LENGTH } from '@octobrief/domain'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCreateProject } from '@/lib/queries'
import { projectHref } from '../shell/navigation'
import { errorKey } from './error-message'

const FORM_ERRORS = ['invalidName', 'invalidClient'] as const

export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('projects')
  const errors = useTranslations('errors')
  const router = useRouter()
  const create = useCreateProject()
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const failure = errorKey(create.error, FORM_ERRORS)

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate(
      { name, client: client.trim() === '' ? null : client },
      {
        onSuccess: (project) => {
          toast.success(t('created', { name: project.name }))
          onOpenChange(false)
          setName('')
          setClient('')
          router.push(projectHref(project.slug))
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('new')}</DialogTitle>
          </DialogHeader>
          <label htmlFor="project-name" className="flex flex-col gap-1.5 text-sm">
            {t('name')}
            <Input
              id="project-name"
              autoFocus
              required
              value={name}
              maxLength={PROJECT_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor="project-client" className="flex flex-col gap-1.5 text-sm">
            {t('client')}
            <Input
              id="project-client"
              value={client}
              maxLength={CLIENT_NAME_MAX_LENGTH}
              onChange={(event) => setClient(event.target.value)}
            />
          </label>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {failure ? t(failure as (typeof FORM_ERRORS)[number]) : errors('generic')}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t('creating') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
