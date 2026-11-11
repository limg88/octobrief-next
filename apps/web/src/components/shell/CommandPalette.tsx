'use client'
import { FolderKanban, Languages, LogOut, Palette, Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { signOut, useProjects } from '@/lib/queries'
import { SECTION_ICONS } from './icons'
import { projectEntries, projectHref } from './navigation'
import { usePreferences } from './use-preferences'

export const NEW_PROJECT_HREF = '/?new=1'

/** ⌘K palette: navigation, project switch and actions. */
export function CommandPalette({
  open,
  onOpenChange,
  slug,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  slug: string | null
}) {
  const t = useTranslations('palette')
  const nav = useTranslations('nav')
  const shell = useTranslations('shell')
  const router = useRouter()
  const locale = useLocale()
  const projects = useProjects().data ?? []
  const preferences = usePreferences()

  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('placeholder')} />
      <CommandList>
        <CommandEmpty>{t('empty')}</CommandEmpty>
        {slug && (
          <CommandGroup heading={t('goTo')}>
            {projectEntries(slug).map((entry) => {
              const Icon = SECTION_ICONS[entry.section]
              return (
                <CommandItem key={entry.section} onSelect={run(() => router.push(entry.href))}>
                  <Icon /> {nav(entry.section)}
                  <CommandShortcut>
                    {shell('shortcut', { key: entry.key.toUpperCase() })}
                  </CommandShortcut>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
        {projects.length > 0 && (
          <CommandGroup heading={t('projects')}>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.client ?? ''}`}
                onSelect={run(() => router.push(projectHref(project.slug)))}
              >
                <FolderKanban /> {project.name}
                {project.client && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {project.client}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={t('actions')}>
          <CommandItem onSelect={run(() => router.push(NEW_PROJECT_HREF))}>
            <Plus /> {t('newProject')}
          </CommandItem>
          <CommandItem onSelect={run(preferences.toggleTheme)}>
            <Palette /> {t('toggleTheme')}
          </CommandItem>
          <CommandItem onSelect={run(() => preferences.setLocale(locale === 'it' ? 'en' : 'it'))}>
            <Languages /> {t('switchLanguage')}
          </CommandItem>
          <CommandItem onSelect={run(() => void signOut())}>
            <LogOut /> {t('signOut')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
