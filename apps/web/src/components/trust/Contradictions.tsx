'use client'
import { TriangleAlertIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { AnswerDto } from '@/lib/api-types'
import { SourceChip } from './SourceChip'

/** Sources that disagree: every side with its own source, never a choice made in silence. */
export function Contradictions({ items }: { items: AnswerDto['contradictions'] }) {
  const t = useTranslations('trust')
  const shown = items.filter((item) => !item.suppressed)
  if (shown.length === 0) return null
  return (
    <section aria-labelledby="contradictions-title" className="flex flex-col gap-2">
      <h3 id="contradictions-title" className="flex items-center gap-1 text-sm font-medium">
        <TriangleAlertIcon className="size-4 text-amber-600" aria-hidden />
        {t('contradictions')}
      </h3>
      <ul className="flex flex-col gap-2">
        {shown.map((item) => (
          <li
            key={item.originalSubject}
            className="flex flex-col gap-2 rounded-lg border border-amber-500/40 p-3"
          >
            <p className="text-sm font-medium">{item.subject}</p>
            <ul className="flex flex-col gap-1">
              {item.sides.map((side, index) => (
                // The sides of a contradiction never move: the position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{side.value ?? t('suspended.generic')}</span>
                  <SourceChip source={side.source} />
                </li>
              ))}
            </ul>
            {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
