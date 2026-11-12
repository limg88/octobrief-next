'use client'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api-client'
import type { DocumentDto } from '@/lib/api-types'
import { useDeleteDocument, useDocuments, useReclassifyDocument } from '@/lib/queries'
import { DocumentRow } from './DocumentRow'
import { DocumentTextDialog } from './DocumentTextDialog'
import { memoryErrorKey } from './format'
import { KnowledgePanel } from './KnowledgePanel'
import { UploadPanel } from './UploadPanel'

const COLUMNS = ['name', 'kind', 'audience', 'date', 'status', 'actions'] as const

/** The Memory section: upload, classification table and text preview. */
export function MemoryView({ slug }: { slug: string }) {
  const t = useTranslations('memory')
  const errors = useTranslations('errors')
  const documents = useDocuments(slug)
  const reclassify = useReclassifyDocument(slug)
  const remove = useDeleteDocument(slug)
  const [viewing, setViewing] = useState<string | null>(null)

  function explain(error: unknown) {
    const key = error instanceof ApiError ? memoryErrorKey(error.code, error.reason) : null
    toast.error(key ? t(`errors.${key}`) : errors('generic'))
  }

  function confirmDelete(document: DocumentDto) {
    if (!window.confirm(t('confirmDelete', { name: document.fileName }))) return
    remove.mutate(document.id, {
      onSuccess: () => toast.success(t('deleted', { name: document.fileName })),
      onError: explain,
    })
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <UploadPanel slug={slug} />
      {documents.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="px-3 py-2 font-medium">
                    {t(`columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.data?.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  onReclassify={(change) =>
                    reclassify.mutate({ id: document.id, ...change }, { onError: explain })
                  }
                  onView={() => setViewing(document.id)}
                  onDelete={() => confirmDelete(document)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('retention')}</p>
      <KnowledgePanel slug={slug} />
      <DocumentTextDialog slug={slug} documentId={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}
