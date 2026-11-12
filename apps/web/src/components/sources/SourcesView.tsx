'use client'
import { isPullSource, isReadByWorker, SOURCE_KINDS, type SourceKind } from '@octobrief/domain'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SourceDto } from '@/lib/api-types'
import {
  useCreateSource,
  useDeleteSource,
  useRotateSourceToken,
  useSources,
  useSyncSource,
} from '@/lib/queries'
import { type PushSetup, SyncFolderForm } from './SyncFolderForm'
import { sourceErrorKey } from './source-errors'

export { SOURCE_ERRORS, sourceErrorKey } from './source-errors'

/** What the form sends for a pulling source: its settings and the projects to read. */
export function pullSettings(kind: SourceKind, account: string, place: string, scope: string) {
  const config =
    kind === 'jira'
      ? { site: place, email: account, readOnlyToken: true }
      : { organization: place, host: 'dev.azure.com', readOnlyToken: true }
  const names = scope
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  return { config, scope: names }
}

function NewSourceForm({ slug, onToken }: { slug: string; onToken: (token: string) => void }) {
  const t = useTranslations('sources')
  const errors = useTranslations('errors')
  const create = useCreateSource(slug)
  const [kind, setKind] = useState<SourceKind>('files')
  const [name, setName] = useState('')
  const [place, setPlace] = useState('')
  const [account, setAccount] = useState('')
  const [scope, setScope] = useState('')
  const [secret, setSecret] = useState('')
  const pull = isPullSource(kind)

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate(
      { kind, name, ...(pull ? { ...pullSettings(kind, account, place, scope), secret } : {}) },
      {
        onSuccess: (created) => {
          toast.success(t('created', { name: created.source.name }))
          if (created.ingestToken) onToken(created.ingestToken)
          setName('')
          setSecret('')
        },
        onError: (error) => {
          const key = sourceErrorKey(error)
          toast.error(key ? t(`errors.${key}`) : errors('generic'))
        },
      },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">{t('new')}</h2>
      <div className="flex flex-wrap gap-3">
        <select
          aria-label={t('kind')}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={kind}
          onChange={(event) => setKind(event.target.value as SourceKind)}
        >
          {SOURCE_KINDS.map((option) => (
            <option key={option} value={option}>
              {t(`kinds.${option}`)}
            </option>
          ))}
        </select>
        <Input
          aria-label={t('name')}
          placeholder={t('name')}
          className="max-w-xs"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">{t(`hints.${kind}`)}</p>
      {pull && (
        <div className="flex flex-wrap gap-3">
          <Input
            aria-label={t(`place.${kind}`)}
            placeholder={t(`place.${kind}`)}
            className="max-w-xs"
            value={place}
            onChange={(event) => setPlace(event.target.value)}
            required
          />
          {kind === 'jira' && (
            <Input
              aria-label={t('account')}
              placeholder={t('account')}
              type="email"
              className="max-w-xs"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              required
            />
          )}
          <Input
            aria-label={t(`scope.${kind}`)}
            placeholder={t(`scope.${kind}`)}
            className="max-w-xs"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            required={kind === 'ado'}
          />
          <Input
            aria-label={t('secret')}
            placeholder={t('secret')}
            type="password"
            autoComplete="off"
            className="max-w-xs"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        </div>
      )}
      <div>
        <Button type="submit" disabled={create.isPending}>
          {t('connect')}
        </Button>
      </div>
    </form>
  )
}

function SourceRow({
  slug,
  source,
  onToken,
}: {
  slug: string
  source: SourceDto
  onToken: (token: string) => void
}) {
  const t = useTranslations('sources')
  const errors = useTranslations('errors')
  const format = useFormatter()
  const remove = useDeleteSource(slug)
  const rotate = useRotateSourceToken(slug)
  const sync = useSyncSource(slug)
  const explain = () => toast.error(errors('generic'))
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' }) : t('never')

  return (
    <tr className="border-t border-border text-sm">
      <td className="px-3 py-2">
        <div className="font-medium">{source.name}</div>
        <div className="text-xs text-muted-foreground">
          {source.feed === 'folder'
            ? t('feeds.folder', {
                system: t(`folder.systems.${source.kind}`),
                path: source.folderPath ?? '',
              })
            : source.feed === 'push' && isPullSource(source.kind)
              ? t('feeds.push', { system: t(`folder.systems.${source.kind}`) })
              : t(`kinds.${source.kind}`)}
        </div>
      </td>
      <td className="px-3 py-2">{source.documentCount}</td>
      <td className="px-3 py-2">{when(source.lastSyncAt)}</td>
      <td className="px-3 py-2">
        {when(source.dataAsOf)}
        {source.lastError && (
          <div role="alert" className="text-xs text-destructive">
            {t('failed', { code: source.lastError })}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {isReadByWorker(source.feed) ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                sync.mutate(source.id, {
                  onSuccess: () => toast.success(t('syncQueued')),
                  onError: explain,
                })
              }
            >
              {t('syncNow')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                rotate.mutate(source.id, {
                  onSuccess: (r) => onToken(r.ingestToken),
                  onError: explain,
                })
              }
            >
              {t('newToken')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!window.confirm(t('confirmDelete', { name: source.name }))) return
              remove.mutate(source.id, { onError: explain })
            }}
          >
            {t('disconnect')}
          </Button>
        </div>
      </td>
    </tr>
  )
}

const COLUMNS = ['source', 'documents', 'lastSync', 'dataAsOf', 'actions'] as const

/** The Sources section: where documents come from, how fresh they are, and how to feed them. */
export function SourcesView({ slug }: { slug: string }) {
  const t = useTranslations('sources')
  const sources = useSources(slug)
  const [token, setToken] = useState<string | null>(null)
  const [setup, setSetup] = useState<PushSetup | null>(null)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      {token && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-4"
        >
          <p className="text-sm font-medium">{t('tokenTitle')}</p>
          <code className="break-all text-xs">{token}</code>
          <p className="text-xs text-muted-foreground">{t('tokenNote')}</p>
          <div>
            <Button variant="outline" size="sm" onClick={() => setToken(null)}>
              {t('tokenDismiss')}
            </Button>
          </div>
        </div>
      )}
      {setup && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-4"
        >
          <p className="text-sm font-medium">{t('folder.setupTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('folder.setupConfig')}</p>
          <pre className="overflow-x-auto text-xs">{setup.config}</pre>
          <p className="text-xs text-muted-foreground">{t('folder.setupEnv')}</p>
          <pre className="overflow-x-auto break-all text-xs">{setup.env}</pre>
          <div>
            <Button variant="outline" size="sm" onClick={() => setSetup(null)}>
              {t('tokenDismiss')}
            </Button>
          </div>
        </div>
      )}
      <NewSourceForm slug={slug} onToken={setToken} />
      <SyncFolderForm slug={slug} onSetup={setSetup} />
      {sources.data?.length === 0 ? (
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
              {sources.data?.map((source) => (
                <SourceRow key={source.id} slug={slug} source={source} onToken={setToken} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
