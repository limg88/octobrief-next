import { romeDateString } from '../rome-time.ts'
import type { WorkItem } from '../tracker.ts'
import type { Recipe } from './format.ts'

// The name of a sprint as the tracker writes it. A cadence counts its sprints from its first day
// («Sprint 3»), while the tracker names them its own way («[DEEM] Sprint 28», the last part of
// the iteration path): a proposal prefills the tracker's name when the work items of the period
// say it, and leaves the field empty otherwise, never with a name made up by the cadence.

/** The text parameters a tracker query of the recipe filters its sprints by. */
export function sprintParameters(recipe: Recipe): string[] {
  const out = new Set<string>()
  for (const section of recipe.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'data_table' && block.kind !== 'data_list') continue
      if (block.query.kind !== 'tracker') continue
      for (const v of block.query.filter.sprints ?? []) {
        if (typeof v !== 'object') continue
        const p = recipe.parameters.find((x) => x.id === v.parameter)
        if (p?.type === 'text') out.add(p.id)
      }
    }
  }
  return [...out]
}

/**
 * The tracker's own name of the sprint of a period: the sprint most work items closed in the
 * period are in (or, with none closed, changed in it), when one sprint leads; null when none
 * does or two are level, never a guess.
 */
export function sprintOfPeriod(
  items: readonly WorkItem[],
  period: { from: string; to: string },
): string | null {
  const within = (at: Date | null) => {
    if (at === null) return false
    const day = romeDateString(at)
    return day >= period.from && day <= period.to
  }
  for (const field of ['closed', 'changed'] as const) {
    const counts = new Map<string, number>()
    for (const item of items) {
      const sprint = item.sprint?.trim() ?? ''
      if (sprint === '' || !within(item[field])) continue
      counts.set(sprint, (counts.get(sprint) ?? 0) + 1)
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    const [first, second] = ranked
    if (first === undefined) continue
    return second !== undefined && second[1] === first[1] ? null : first[0]
  }
  return null
}
