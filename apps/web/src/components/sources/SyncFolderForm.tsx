'use client'
import { SOURCE_KINDS, type SourceKind } from '@octobrief/domain'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCreateSource } from '@/lib/queries'
import { sourceErrorKey } from './source-errors'

/** How a synchronized folder reaches Octobrief: read here by the worker, or sent from a PC. */
export type FolderMode = 'folder' | 'push'

export interface PushedSource {
  readonly kind: SourceKind
  readonly id: string
  readonly token: string
}

/** What the PM pastes on the PC: the sources for the configuration, the tokens for its `.env`. */
export interface PushSetup {
  readonly config: string
  readonly env: string
}

const tokenVariable = (kind: SourceKind) => `OCTOBRIEF_TOKEN_${kind.toUpperCase()}`

/**
 * The `push` block of the synchronization's configuration and the lines of its private `.env`:
 * the configuration names the variables, only the `.env` holds the tokens.
 */
export function pushSetup(server: string, sources: readonly PushedSource[]): PushSetup {
  const entries = Object.fromEntries(
    sources.map((source) => [source.kind, { id: source.id, tokenEnv: tokenVariable(source.kind) }]),
  )
  return {
    config: JSON.stringify({ push: { server, sources: entries } }, null, 2),
    env: sources.map((source) => `${tokenVariable(source.kind)}=${source.token}`).join('\n'),
  }
}

const DEFAULT_SYSTEMS: readonly SourceKind[] = ['jira', 'ado', 'm365', 'dwsi']

/**
 * Connects a synchronized folder: one source for each system it holds, each of its own kind, so
 * that what depends on the kind (the tracker dashboards, the economic reports) works as with a
 * direct connection.
 */
export function SyncFolderForm({
  slug,
  onSetup,
}: {
  slug: string
  onSetup: (setup: PushSetup) => void
}) {
  const t = useTranslations('sources')
  const errors = useTranslations('errors')
  const create = useCreateSource(slug)
  const [mode, setMode] = useState<FolderMode>('folder')
  const [path, setPath] = useState('')
  const [systems, setSystems] = useState<readonly SourceKind[]>(DEFAULT_SYSTEMS)

  const toggle = (kind: SourceKind) =>
    setSystems((now) => (now.includes(kind) ? now.filter((k) => k !== kind) : [...now, kind]))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const pushed: PushedSource[] = []
    try {
      for (const kind of SOURCE_KINDS.filter((k) => systems.includes(k))) {
        const created = await create.mutateAsync({
          kind,
          name: t('folder.sourceName', { system: t(`folder.systems.${kind}`) }),
          feed: mode,
          ...(mode === 'folder' ? { folderPath: path } : {}),
        })
        if (created.ingestToken)
          pushed.push({ kind, id: created.source.id, token: created.ingestToken })
      }
      toast.success(t('folder.connected'))
      if (pushed.length > 0) onSetup(pushSetup(window.location.origin, pushed))
    } catch (error) {
      const key = sourceErrorKey(error)
      toast.error(key ? t(`errors.${key}`) : errors('generic'))
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium">{t('folder.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('folder.hint')}</p>
      <div className="flex flex-wrap gap-3">
        <select
          aria-label={t('folder.mode')}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={mode}
          onChange={(event) => setMode(event.target.value as FolderMode)}
        >
          <option value="folder">{t('folder.modes.folder')}</option>
          <option value="push">{t('folder.modes.push')}</option>
        </select>
        {mode === 'folder' && (
          <Input
            aria-label={t('folder.path')}
            placeholder={t('folder.path')}
            className="max-w-md"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            required
          />
        )}
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">{t('folder.systemsLabel')}</legend>
        {SOURCE_KINDS.map((kind) => (
          <label key={kind} className="flex items-center gap-1.5">
            <input type="checkbox" checked={systems.includes(kind)} onChange={() => toggle(kind)} />
            {t(`folder.systems.${kind}`)}
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="submit" disabled={create.isPending || systems.length === 0}>
          {t('folder.connect')}
        </Button>
      </div>
    </form>
  )
}
