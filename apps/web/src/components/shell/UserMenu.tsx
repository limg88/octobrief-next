'use client'
import { isAdmin, LOCALES, type Locale } from '@octobrief/domain'
import { ChevronsUpDown, Languages, LogOut, Palette, ShieldCheck } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { signOut } from '@/lib/queries'
import { useSession } from './session-context'
import { usePreferences } from './use-preferences'

const LOCALE_NAMES: Record<Locale, string> = { it: 'Italiano', en: 'English' }
const THEMES = ['dark', 'light', 'system'] as const
const THEME_LABELS = { dark: 'themeDark', light: 'themeLight', system: 'themeSystem' } as const

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

export function UserMenu() {
  const t = useTranslations('shell')
  const locale = useLocale()
  const { user } = useSession()
  const preferences = usePreferences()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-solid text-[11px] font-semibold text-primary-foreground">
          {initials(user.displayName)}
        </span>
        <span className="truncate">{user.displayName}</span>
        {isAdmin(user) && <ShieldCheck className="size-3.5 text-primary" aria-label={t('admin')} />}
        <ChevronsUpDown className="ml-auto size-3.5 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette /> {t('theme')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={preferences.theme ?? 'dark'}
              onValueChange={preferences.setTheme}
            >
              {THEMES.map((theme) => (
                <DropdownMenuRadioItem key={theme} value={theme}>
                  {t(THEME_LABELS[theme])}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages /> {t('language')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={locale}
              onValueChange={(value) => preferences.setLocale(value as Locale)}
            >
              {LOCALES.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {LOCALE_NAMES[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> {t('signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
