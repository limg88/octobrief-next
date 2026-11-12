import { Brain, Cable, FileText, LayoutDashboard, type LucideIcon, Sparkles } from 'lucide-react'
import type { Section } from './navigation'

export const SECTION_ICONS: Record<Section, LucideIcon> = {
  overview: LayoutDashboard,
  ask: Sparkles,
  deliverables: FileText,
  memory: Brain,
  sources: Cable,
}
