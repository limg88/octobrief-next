'use client'
import { AUDIENCES, type Audience, DOCUMENT_KINDS, type DocumentKind } from '@octobrief/domain'
import { EyeIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { DocumentDto } from '@/lib/api-types'
import { cn } from '@/lib/utils'
import { formatSize } from './format'

const STATUS_STYLES: Record<DocumentDto['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  ready: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/10 text-destructive',
}

const SELECT_CLASS =
  'h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60'

function ToConfirm({ show }: { show: boolean }) {
  const t = useTranslations('memory')
  if (!show) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
      <TriangleAlertIcon className="size-3" aria-hidden />
      {t('toConfirm')}
    </span>
  )
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>
}

export interface DocumentRowProps {
  document: DocumentDto
  onReclassify: (change: { kind?: DocumentKind; audience?: Audience }) => void
  onView: () => void
  onDelete: () => void
}

export function DocumentRow({ document, onReclassify, onView, onDelete }: DocumentRowProps) {
  const t = useTranslations('memory')
  const kinds = useTranslations('documentKinds')
  const audiences = useTranslations('audiences')
  const statuses = useTranslations('documentStatus')
  const sources = useTranslations('dateSources')
  const warnings = useTranslations('extractionWarnings')
  const format = useFormatter()
  const ready = document.status === 'ready'
  const uncertain = new Set(document.uncertain)

  return (
    <tr className="border-t border-border text-sm">
      <Cell>
        <div className="font-medium">{document.fileName}</div>
        <div className="text-xs text-muted-foreground">
          {formatSize(document.sizeBytes)} · {document.uploaderName} ·{' '}
          {t('chunks', { count: document.chunkCount })}
        </div>
        {document.sourceName && (
          <div className="text-xs text-muted-foreground">
            {t('fromSource', { source: document.sourceName })}
          </div>
        )}
      </Cell>
      <Cell>
        <select
          aria-label={`${t('columns.kind')} ${document.fileName}`}
          className={SELECT_CLASS}
          disabled={!ready}
          value={document.kind ?? ''}
          onChange={(event) => onReclassify({ kind: event.target.value as DocumentKind })}
        >
          {!document.kind && <option value="">—</option>}
          {DOCUMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kinds(kind)}
            </option>
          ))}
        </select>
        <ToConfirm show={uncertain.has('kind')} />
      </Cell>
      <Cell>
        <select
          aria-label={`${t('columns.audience')} ${document.fileName}`}
          className={SELECT_CLASS}
          disabled={!ready || document.audienceSource === 'rule'}
          value={document.audience ?? ''}
          onChange={(event) => onReclassify({ audience: event.target.value as Audience })}
        >
          {!document.audience && <option value="">—</option>}
          {AUDIENCES.map((audience) => (
            <option key={audience} value={audience}>
              {audiences(audience)}
            </option>
          ))}
        </select>
        <ToConfirm show={uncertain.has('audience')} />
      </Cell>
      <Cell>
        {document.documentDate && document.dateSource ? (
          <>
            <div>{format.dateTime(new Date(document.documentDate), { dateStyle: 'medium' })}</div>
            <div className="text-xs text-muted-foreground">
              {t('dateFrom', { source: sources(document.dateSource) })}
            </div>
            <ToConfirm show={uncertain.has('date')} />
          </>
        ) : (
          '—'
        )}
      </Cell>
      <Cell>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            STATUS_STYLES[document.status],
          )}
        >
          {statuses(document.status)}
        </span>
        {document.warnings.length > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">
            {document.warnings
              .map((warning) => (warnings.has(warning) ? warnings(warning) : warning))
              .join(', ')}
          </div>
        )}
      </Cell>
      <Cell>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${t('view')} ${document.fileName}`}
            disabled={!ready}
            onClick={onView}
          >
            <EyeIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${t('delete')} ${document.fileName}`}
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      </Cell>
    </tr>
  )
}
