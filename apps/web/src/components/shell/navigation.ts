/** The sections of a project, with the key of the «G then …» shortcut. */
export const SECTIONS = ['overview', 'ask', 'deliverables', 'memory'] as const
export type Section = (typeof SECTIONS)[number]

export interface NavEntry {
  section: Section
  href: string
  key: string
}

const SECTION_KEYS: Record<Section, string> = {
  overview: 'p',
  ask: 'c',
  deliverables: 'd',
  memory: 'm',
}

export function projectHref(slug: string, section: Section = 'overview'): string {
  const base = `/projects/${encodeURIComponent(slug)}`
  return section === 'overview' ? base : `${base}/${section}`
}

export function projectEntries(slug: string): NavEntry[] {
  return SECTIONS.map((section) => ({
    section,
    href: projectHref(slug, section),
    key: SECTION_KEYS[section],
  }))
}

export function isActive(pathname: string, entry: NavEntry): boolean {
  if (entry.section === 'overview') return pathname === entry.href
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`)
}

/** The project slug of a Studio path, or null outside a project. */
export function slugFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export function isSection(value: string): value is Section {
  return (SECTIONS as readonly string[]).includes(value)
}
