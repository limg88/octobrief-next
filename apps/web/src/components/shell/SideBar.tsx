'use client'
import { ChevronsUpDown, Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useProjects } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { SECTION_ICONS } from './icons'
import { isActive, projectEntries, projectHref } from './navigation'
import { UserMenu } from './UserMenu'

/** Fixed Linear-like sidebar: product, project switcher, search/⌘K, sections, user. */
export function SideBar({ slug, onSearch }: { slug: string | null; onSearch: () => void }) {
  const t = useTranslations('shell')
  const nav = useTranslations('nav')
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const projects = useProjects().data ?? []
  const current = projects.find((p) => p.slug === slug) ?? null

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-2 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
      <Link href="/" className="px-2 pt-1 text-sm font-semibold">
        {t('product')}
      </Link>
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-sidebar-accent">
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary-solid text-[11px] font-semibold text-primary-foreground">
              {(current?.name ?? 'P').charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{current?.name ?? t('chooseProject')}</span>
            <ChevronsUpDown className="ml-auto size-3.5 opacity-50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('projects')}
            </DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => router.push(projectHref(project.slug))}
              >
                <span className="truncate">{project.name}</span>
                {project.client && (
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {project.client}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            {projects.length === 0 && (
              <DropdownMenuItem disabled>{t('noProjects')}</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push('/')}>
              {t('allProjects')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onSearch}
          aria-label={t('search')}
          title="⌘K"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          <Search className="size-4" />
        </button>
      </div>

      {slug && (
        <nav className="flex flex-col gap-0.5">
          {projectEntries(slug).map((entry) => {
            const Icon = SECTION_ICONS[entry.section]
            const active = isActive(pathname, entry)
            return (
              <Link
                key={entry.section}
                href={entry.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                  active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                )}
              >
                <Icon className="size-4" />
                <span>{nav(entry.section)}</span>
                <kbd className="ml-auto text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
                  {t('shortcut', { key: entry.key.toUpperCase() })}
                </kbd>
              </Link>
            )
          })}
        </nav>
      )}

      <div className="mt-auto">
        <UserMenu />
      </div>
    </aside>
  )
}
