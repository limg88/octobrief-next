'use client'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { FindingDto, RecipeDto, RunViewDto } from '@/lib/api-types'
import {
  useAcceptFinding,
  useApproveRun,
  useDocuments,
  useRecipes,
  useRequestChange,
  useRun,
  useRuns,
  useStartRun,
} from '@/lib/queries'
import { cn } from '@/lib/utils'
import { DocumentView } from './DocumentView'
import { RunForm } from './RunForm'

/** Where a finding is, in words: the section and the block, when known. */
const placeOf = (finding: FindingDto) =>
  [finding.place.section, finding.place.block].filter(Boolean).join(' › ')

function Finding({
  slug,
  runId,
  finding,
  decidable,
}: {
  slug: string
  runId: string
  finding: FindingDto
  decidable: boolean
}) {
  const t = useTranslations('deliverables')
  const errors = useTranslations('errors')
  const accept = useAcceptFinding(slug, runId)
  const change = useRequestChange(slug, runId)
  const [text, setText] = useState('')
  const open = finding.status === 'open'
  const explain = () => toast.error(errors('generic'))

  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3',
        open ? 'border-destructive/40' : 'border-border',
      )}
    >
      <p className="text-sm">{finding.text}</p>
      <p className="text-xs text-muted-foreground">
        {t(`findingKind.${finding.kind}`)} · {t(`findingClass.${finding.class}`)}
        {placeOf(finding) && ` · ${placeOf(finding)}`}
        {finding.status && ` · ${t(`findingStatus.${finding.status}`)}`}
      </p>
      {open && decidable && (finding.slot || finding.acceptable) && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('reasonFor', { text: finding.text })}
            placeholder={finding.slot ? t('changePlaceholder') : t('reasonPlaceholder')}
            className="max-w-md"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {finding.slot && (
            <Button
              variant="outline"
              size="sm"
              disabled={text.trim() === '' || change.isPending}
              onClick={() =>
                change.mutate(
                  { slots: [finding.slot as string], request: text },
                  { onSuccess: () => toast.success(t('changeQueued')), onError: explain },
                )
              }
            >
              {t('requestChange')}
            </Button>
          )}
          {finding.acceptable && (
            <Button
              variant="outline"
              size="sm"
              disabled={accept.isPending}
              onClick={() =>
                accept.mutate(
                  { code: finding.code, refKey: finding.refKey, reason: text },
                  { onError: () => toast.error(t('reasonTooShort')) },
                )
              }
            >
              {t('accept')}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

function Files({ slug, view }: { slug: string; view: RunViewDto }) {
  const t = useTranslations('deliverables')
  if (view.files.length === 0) return null
  return (
    <section aria-label={t('files')} className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{t('files')}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {view.files.map((file) => (
          <li key={file.id}>
            <a
              className="underline"
              href={`/api/projects/${encodeURIComponent(slug)}/runs/${view.run.id}/files/${file.id}`}
            >
              {file.fileName}
            </a>{' '}
            <span className="text-xs text-muted-foreground">
              ({t(`audience.${file.audience}`)})
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A run under review: its state, its document, what the checks found and what can be done. */
function RunReview({ slug, runId }: { slug: string; runId: string }) {
  const t = useTranslations('deliverables')
  const errors = useTranslations('errors')
  const run = useRun(slug, runId)
  const approve = useApproveRun(slug, runId)
  const view = run.data
  if (!view) return null
  const { status, phase, approval } = view.run
  // A render that failed can be asked again: the document is still waiting for its files.
  const decidable = status === 'ready' && (approval === null || approval === 'render_failed')
  const anomalies = view.findings.filter((finding) => finding.kind === 'anomaly')
  const warnings = view.findings.filter((finding) => finding.kind === 'warning')

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{view.run.recipeTitle}</h2>
        <p role="status" className="text-sm text-muted-foreground">
          {approval
            ? t(`approval.${approval}`)
            : phase
              ? t(`phase.${phase}`)
              : t(`status.${status}`)}
          {view.revision > 0 && ` · ${t('revision', { n: view.revision })}`}
        </p>
        {view.run.errorCode && (
          <p role="alert" className="text-sm text-destructive">
            {t('failed', { code: view.run.errorCode })}
          </p>
        )}
        {view.run.revisionError && (
          <p role="alert" className="text-sm text-destructive">
            {t('revisionNotKept', { code: view.run.revisionError })}
          </p>
        )}
        {view.run.approvalError && (
          <p role="alert" className="text-sm text-destructive">
            {t('renderFailed', { code: view.run.approvalError })}
          </p>
        )}
      </header>
      {view.summary && (
        <p className="text-sm">
          {t('summary', {
            checks: view.summary.checks,
            open: view.summary.open,
            accepted: view.summary.accepted,
          })}
        </p>
      )}
      {anomalies.length > 0 && (
        <section aria-label={t('anomalies')} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('anomalies')}</h3>
          <ul className="flex flex-col gap-2">
            {anomalies.map((finding) => (
              <Finding
                key={`${finding.code}|${finding.refKey}`}
                slug={slug}
                runId={runId}
                finding={finding}
                decidable={decidable}
              />
            ))}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section aria-label={t('warnings')} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('warnings')}</h3>
          <ul className="flex flex-col gap-2">
            {warnings.map((finding) => (
              <Finding
                key={`${finding.code}|${finding.refKey}`}
                slug={slug}
                runId={runId}
                finding={finding}
                decidable={false}
              />
            ))}
          </ul>
        </section>
      )}
      {decidable && (
        <div className="flex items-center gap-3">
          <Button
            disabled={!view.approvable || approve.isPending}
            onClick={() =>
              approve.mutate(undefined, { onError: () => toast.error(errors('generic')) })
            }
          >
            {t('approve')}
          </Button>
          {!view.approvable && (
            <span className="text-xs text-muted-foreground">{t('notApprovable')}</span>
          )}
        </div>
      )}
      <Files slug={slug} view={view} />
      {view.document && <DocumentView document={view.document} />}
    </div>
  )
}

/** The Deliverables section: the catalog of recipes, the runs of the project and their review. */
export function DeliverablesView({ slug }: { slug: string }) {
  const t = useTranslations('deliverables')
  const errors = useTranslations('errors')
  const recipes = useRecipes()
  const runs = useRuns(slug)
  const documents = useDocuments(slug)
  const start = useStartRun(slug)
  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <div className="grid gap-6 md:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-4">
          <section aria-label={t('catalog')} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{t('catalog')}</h2>
            <ul className="flex flex-col gap-1">
              {recipes.data?.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setRecipe(entry)
                      setSelected(null)
                    }}
                  >
                    <span className="font-medium">{entry.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {entry.formats.join(', ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <nav aria-label={t('runs')} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{t('runs')}</h2>
            {runs.data?.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('noRuns')}</p>
            )}
            <ul className="flex flex-col gap-1">
              {runs.data?.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    aria-current={run.id === selected ? 'true' : undefined}
                    className={cn(
                      'w-full rounded px-2 py-1 text-left text-sm hover:bg-accent',
                      run.id === selected && 'bg-accent font-medium',
                    )}
                    onClick={() => {
                      setSelected(run.id)
                      setRecipe(null)
                    }}
                  >
                    {run.recipeTitle}
                    <span className="block text-xs text-muted-foreground">
                      {run.approval ? t(`approval.${run.approval}`) : t(`status.${run.status}`)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
        <main className="min-w-0">
          {recipe && (
            <RunForm
              key={recipe.slug}
              recipe={recipe}
              documents={documents.data ?? []}
              pending={start.isPending}
              onCancel={() => setRecipe(null)}
              onSubmit={(parameters) =>
                start.mutate(
                  { recipeSlug: recipe.slug, parameters },
                  {
                    onSuccess: (run) => {
                      setRecipe(null)
                      setSelected(run.id)
                    },
                    onError: () => toast.error(errors('generic')),
                  },
                )
              }
            />
          )}
          {!recipe && selected && <RunReview key={selected} slug={slug} runId={selected} />}
          {!recipe && !selected && <p className="text-sm text-muted-foreground">{t('choose')}</p>}
        </main>
      </div>
    </div>
  )
}
