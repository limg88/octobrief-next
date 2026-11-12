'use client'
import { useTranslations } from 'next-intl'
import { Freshness, KindBadge } from '@/components/trust/badges'
import { Contradictions } from '@/components/trust/Contradictions'
import { SourceChip } from '@/components/trust/SourceChip'
import type { AnswerDto, AnswerSegmentDto } from '@/lib/api-types'

function Segment({ segment }: { segment: AnswerSegmentDto }) {
  const t = useTranslations('trust')
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {segment.text === null ? (
        // The checks suspended the sentence: what the model wrote is never shown as true.
        <p role="alert" className="text-sm text-destructive">
          {t(`suspended.${segment.suspendedReason ?? 'without_source'}`)}
        </p>
      ) : (
        <p className="text-sm">{segment.text}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge nature={segment.nature} />
        {segment.sources.length > 0 && (
          <Freshness level={segment.freshness} warning={segment.warning} />
        )}
        {segment.contested && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            {t('contested')}
          </span>
        )}
      </div>
      {segment.sources.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {segment.sources.map((source, index) => (
            // Sources keep the order the answer cites them in.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index}>
              <SourceChip source={source} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** What the checks found, by kind, with how many times. */
export function anomalyCounts(answer: AnswerDto): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const { code } of answer.checks.list) counts.set(code, (counts.get(code) ?? 0) + 1)
  return [...counts]
}

/** A verified answer: sentences with their sources, contradictions, what is missing, checks. */
export function AnswerView({ answer }: { answer: AnswerDto }) {
  const t = useTranslations('ask')
  const absences = answer.absences.filter((absence) => !absence.suppressed)
  const trust = useTranslations('trust')
  const anomalies = anomalyCounts(answer)
  return (
    <div className="flex flex-col gap-4">
      {answer.segments.length === 0 && absences.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('nothing')}</p>
      )}
      <ol className="flex flex-col gap-2">
        {answer.segments.map((segment, index) => (
          // Sentences are shown in the order of the answer and never reordered.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Segment key={index} segment={segment} />
        ))}
      </ol>
      <Contradictions items={answer.contradictions} />
      {absences.length > 0 && (
        <section aria-labelledby="absences-title" className="flex flex-col gap-2">
          <h3 id="absences-title" className="text-sm font-medium">
            {t('absences')}
          </h3>
          <ul className="flex flex-col gap-2">
            {absences.map((absence) => (
              <li key={absence.originalQuestion} className="rounded-lg border border-border p-3">
                <p className="text-sm">{absence.question}</p>
                <p className="text-xs text-muted-foreground">{absence.proposal}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        {t('checks', { total: answer.checks.total, anomalies: answer.checks.anomalies })}
      </p>
      {anomalies.length > 0 && (
        <ul aria-label={trust('anomalies')} className="flex flex-col gap-0.5 text-xs">
          {anomalies.map(([code, count]) => (
            <li key={code} className="text-amber-700 dark:text-amber-400">
              {trust(`anomaly.${code}`)}
              {count > 1 ? ` (${count})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
