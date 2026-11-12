'use client'
import type { FactKind } from '@octobrief/domain'
import { useTranslations } from 'next-intl'
import type { FactDto } from '@/lib/api-types'
import { useKnowledge } from '@/lib/queries'
import { locatorMessage } from './format'

/** The order the kinds of fact are shown in: what moves a project first. */
export const KIND_ORDER: readonly FactKind[] = [
  'status',
  'milestone',
  'decision',
  'risk',
  'action',
  'economics',
  'person',
  'note',
]

export function factsByKind(facts: readonly FactDto[]): Array<[FactKind, FactDto[]]> {
  return KIND_ORDER.map((kind): [FactKind, FactDto[]] => [
    kind,
    facts.filter((fact) => fact.kind === kind),
  ]).filter(([, group]) => group.length > 0)
}

function FactItem({ fact }: { fact: FactDto }) {
  const t = useTranslations('knowledge')
  const locators = useTranslations('locators')
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm">{fact.statement}</p>
        {fact.value !== null && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{fact.value}</span>
        )}
        {fact.state === 'contested' && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
            {t('contested')}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {fact.sources.map((source) => {
          const { key, values } = locatorMessage(source.locator)
          const place = locators(key, values)
          return (
            <li
              key={`${source.documentId}-${place}`}
              className="border-l-2 border-border pl-2 text-xs text-muted-foreground"
            >
              <span className="font-medium">
                {source.fileName} · {place}
              </span>
              <q className="ml-1 italic">{source.excerpt}</q>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

/** «Cosa ho capito»: the facts the documents state, each with the exact text it comes from. */
export function KnowledgePanel({ slug }: { slug: string }) {
  const t = useTranslations('knowledge')
  const knowledge = useKnowledge(slug)
  const facts = knowledge.data?.facts ?? []
  const progress = knowledge.data?.progress
  const groups = factsByKind(facts)

  return (
    <section aria-labelledby="knowledge-title" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 id="knowledge-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      {progress && progress.reading > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('reading', { count: progress.reading })}
        </p>
      )}
      {progress && progress.failed > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {t('failed', { count: progress.failed })}
        </p>
      )}
      {knowledge.data && facts.length === 0 && progress?.reading === 0 && (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {groups.map(([kind, group]) => (
        <div key={kind} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            {t(`kinds.${kind}`)} <span className="text-muted-foreground">({group.length})</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {group.map((fact) => (
              <FactItem key={fact.id} fact={fact} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
