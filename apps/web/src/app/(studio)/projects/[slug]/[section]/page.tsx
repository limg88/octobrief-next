import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { SECTION_ICONS } from '@/components/shell/icons'
import { isSection } from '@/components/shell/navigation'

/** Sections that arrive with later increments: a placeholder that says when. */
export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  if (!isSection(section) || section === 'overview' || section === 'memory') notFound()
  const t = await getTranslations()
  const Icon = SECTION_ICONS[section]
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 pt-24 text-center">
      <Icon className="size-8 text-muted-foreground" />
      <h1 className="text-xl font-semibold">{t(`nav.${section}`)}</h1>
      <p className="text-sm text-muted-foreground">{t(`placeholder.${section}`)}</p>
    </div>
  )
}
