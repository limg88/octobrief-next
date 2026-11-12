'use client'
import { useFormatter, useTranslations } from 'next-intl'
import { locatorMessage } from '@/components/memory/format'
import type { AnswerSourceDto } from '@/lib/api-types'
import { cn } from '@/lib/utils'

/** Where in its source a citation points, in words; null for a fact (it has no place). */
export function usePlace(ref: AnswerSourceDto['ref']): string | null {
  const locators = useTranslations('locators')
  const t = useTranslations('trust')
  if ('factId' in ref) return t('fact')
  if ('sourceId' in ref) {
    return ref.locator.kind === 'work_item' ? t('workItem', { id: ref.locator.id }) : t('counts')
  }
  const { key, values } = locatorMessage(ref.locator)
  return locators(key, values)
}

/**
 * A cited source: its registered title, the place cited and its date. A citation the checks
 * could not verify is shown struck through, with the reason: never as if it stood.
 */
export function SourceChip({ source }: { source: AnswerSourceDto }) {
  const t = useTranslations('trust')
  const format = useFormatter()
  const place = usePlace(source.ref)
  const date = source.sourceDate
    ? format.dateTime(new Date(source.sourceDate), { dateStyle: 'short' })
    : t('noDate')
  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs',
        !source.verified && 'border-destructive/40 text-muted-foreground line-through',
      )}
      title={source.verified ? undefined : t(`unverified.${source.reason ?? 'unknown_source'}`)}
    >
      <span className="font-medium">{source.title ?? t('unknownSource')}</span>
      {place && <span>· {place}</span>}
      <span>· {date}</span>
      {source.pmAsserted && <span>· {t('pmAsserted')}</span>}
      {!source.verified && (
        <span className="no-underline">
          ({t(`unverified.${source.reason ?? 'unknown_source'}`)})
        </span>
      )}
    </span>
  )
}
