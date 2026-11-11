'use client'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useDocumentText } from '@/lib/queries'
import { locatorMessage } from './format'

/** The start of a document's extracted text, each passage with its place in the document. */
export function DocumentTextDialog({
  slug,
  documentId,
  onClose,
}: {
  slug: string
  documentId: string | null
  onClose: () => void
}) {
  const t = useTranslations('memory')
  const locators = useTranslations('locators')
  const text = useDocumentText(slug, documentId)
  const chunks = text.data?.chunks ?? []

  return (
    <Dialog open={documentId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{text.data?.document.fileName ?? t('textTitle')}</DialogTitle>
          <DialogDescription>{t('textNote', { count: chunks.length })}</DialogDescription>
        </DialogHeader>
        {text.isSuccess && chunks.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noText')}</p>
        )}
        <ol className="flex flex-col gap-3">
          {chunks.map((chunk, index) => {
            const { key, values } = locatorMessage(chunk.locator)
            return (
              // Passages never move once extracted: the position is a stable key.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <li key={index} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {locators(key, values)}
                </span>
                <p className="whitespace-pre-wrap text-sm">{chunk.text}</p>
              </li>
            )
          })}
        </ol>
      </DialogContent>
    </Dialog>
  )
}
