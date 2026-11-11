'use client'
import { UploadIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api-client'
import { useUploadDocument } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { memoryErrorKey } from './format'

/** Drop zone and file picker; files are uploaded one after the other. */
export function UploadPanel({ slug }: { slug: string }) {
  const t = useTranslations('memory')
  const errors = useTranslations('errors')
  const upload = useUploadDocument(slug)
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  async function send(files: readonly File[]) {
    for (const file of files) {
      try {
        await upload.mutateAsync(file)
        toast.success(t('uploaded', { name: file.name }))
      } catch (error) {
        const key = error instanceof ApiError ? memoryErrorKey(error.code, error.reason) : null
        toast.error(`${file.name}: ${key ? t(`errors.${key}`) : errors('generic')}`)
      }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    void send([...event.dataTransfer.files])
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    void send(files)
  }

  return (
    <section
      aria-label={t('dropHere')}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center',
        dragging && 'border-primary bg-accent',
      )}
    >
      <UploadIcon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm">
        {t('dropHere')}{' '}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => input.current?.click()}
        >
          {t('choose')}
        </button>
      </p>
      <p className="text-xs text-muted-foreground">{t('limits')}</p>
      {upload.isPending && upload.variables && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('uploading', { name: upload.variables.name })}
        </p>
      )}
      <input ref={input} type="file" multiple hidden data-testid="file-input" onChange={onPick} />
    </section>
  )
}
