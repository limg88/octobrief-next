'use client'
import { useTranslations } from 'next-intl'
import type { AnswerSegmentDto } from '@/lib/api-types'
import { cn } from '@/lib/utils'

const BADGE = 'rounded px-1.5 py-0.5 text-xs font-medium'

/** What a sentence is: something the sources say, a deduction, or a suggestion. */
export function KindBadge({ nature }: { nature: AnswerSegmentDto['nature'] }) {
  const t = useTranslations('trust.nature')
  return (
    <span className={cn(BADGE, nature === 'fact' ? 'bg-muted' : 'border border-border')}>
      {t(nature)}
    </span>
  )
}

const FRESHNESS_STYLE: Record<AnswerSegmentDto['freshness'], string> = {
  fresh: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  dated: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  stale: 'bg-destructive/10 text-destructive',
  unknown: 'bg-destructive/10 text-destructive',
}

/** How fresh the data behind a sentence is, and what to do when it is not. */
export function Freshness({
  level,
  warning,
}: {
  level: AnswerSegmentDto['freshness']
  warning: AnswerSegmentDto['warning']
}) {
  const t = useTranslations('trust.freshness')
  return (
    <span className={cn(BADGE, FRESHNESS_STYLE[level])}>
      {t(`level.${level}`)}
      {warning ? ` · ${t(`note.${warning}`)}` : ''}
    </span>
  )
}
