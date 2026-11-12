'use client'
import { isTerminalPhase } from '@octobrief/domain'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  useAskQuestion,
  useDeleteQuestion,
  useQuestion,
  useQuestionProgress,
  useQuestions,
} from '@/lib/queries'
import { cn } from '@/lib/utils'
import { AnswerView } from './AnswerView'

/** A question being answered or already answered, with its progress. */
function QuestionPanel({ slug, id }: { slug: string; id: string }) {
  const t = useTranslations('ask')
  const errors = useTranslations('ask.errors')
  const question = useQuestion(slug, id)
  const live = useQuestionProgress(slug, id, question.data?.phase)
  const phase = live ?? question.data?.phase ?? 'queued'
  if (!question.data) return null
  return (
    <article className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{question.data.text}</h2>
      {!isTerminalPhase(phase) && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(`phase.${phase}`)}
        </p>
      )}
      {phase === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {errors.has(question.data.error ?? '')
            ? errors(question.data.error as string)
            : errors('generic')}
        </p>
      )}
      {question.data.answer && <AnswerView answer={question.data.answer} />}
    </article>
  )
}

/** The Ask section: a question box, the answer with its sources, the history of questions. */
export function AskView({ slug }: { slug: string }) {
  const t = useTranslations('ask')
  const errors = useTranslations('errors')
  const format = useFormatter()
  const questions = useQuestions(slug)
  const ask = useAskQuestion(slug)
  const remove = useDeleteQuestion(slug)
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected ?? questions.data?.[0]?.id ?? null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (text.trim() === '') return
    ask.mutate(text, {
      onSuccess: (question) => {
        setSelected(question.id)
        setText('')
      },
      onError: () => toast.error(errors('generic')),
    })
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <textarea
          aria-label={t('question')}
          placeholder={t('placeholder')}
          className="min-h-20 rounded-md border border-input bg-background p-3 text-sm"
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div>
          <Button type="submit" disabled={ask.isPending || text.trim() === ''}>
            {t('send')}
          </Button>
        </div>
      </form>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div>{current && <QuestionPanel key={current} slug={slug} id={current} />}</div>
        <nav aria-label={t('history')} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t('history')}</h2>
          {questions.data?.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('noHistory')}</p>
          )}
          <ul className="flex flex-col gap-1">
            {questions.data?.map((question) => (
              <li key={question.id} className="flex items-start gap-1">
                <button
                  type="button"
                  onClick={() => setSelected(question.id)}
                  aria-current={question.id === current ? 'true' : undefined}
                  className={cn(
                    'flex-1 rounded px-2 py-1 text-left text-xs hover:bg-accent',
                    question.id === current && 'bg-accent font-medium',
                  )}
                >
                  <span className="line-clamp-2">{question.text}</span>
                  <span className="text-muted-foreground">
                    {format.dateTime(new Date(question.askedAt), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t('remove', { text: question.text })}
                  className="rounded px-1 text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    if (question.id === selected) setSelected(null)
                    remove.mutate(question.id)
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  )
}
