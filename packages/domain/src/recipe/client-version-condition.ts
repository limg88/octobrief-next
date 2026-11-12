import type { Recipe } from './format.ts'

// Whether a run of a recipe has a client version. A recipe for the client has one, an internal
// recipe none; a recipe of both versions has one unless it makes it depend on a choice of the PM
// (`clientVersionWhen`): then only the typed answer that asks for it gives one. Skipped, answered
// otherwise or not readable, the deliverable is internal only: the restrictive default.

/** The option a run chose for a choice parameter, as a run stores it typed; null otherwise. */
function typedChoice(stored: unknown): string | null {
  if (typeof stored !== 'object' || stored === null) return null
  const { type, value } = stored as { type?: unknown; value?: unknown }
  return type === 'choice' && typeof value === 'string' ? value : null
}

/** Whether a run of `recipe` with these typed parameters has a client version. */
export function hasClientVersion(
  recipe: Recipe,
  parameters: Readonly<Record<string, unknown>>,
): boolean {
  if (recipe.audience === 'internal') return false
  const when = recipe.clientVersionWhen
  if (when === undefined) return true
  if (recipe.audience !== 'both') return false
  const stored = Object.hasOwn(parameters, when.parameter) ? parameters[when.parameter] : undefined
  return typedChoice(stored) === when.equals
}

/**
 * The data blocks a run with a client version reads as the client's (only the trackers of the
 * client): those of a section of the client version, and those a value of that version counts or
 * sums, along the values it is computed from, even when the block itself stays in the internal
 * version. A value for the client never counts, nor cites, what the client document may not.
 */
export function blocksReadForClient(recipe: Recipe): ReadonlySet<string> {
  const blocks = new Map(recipe.sections.flatMap((s) => s.blocks.map((b) => [b.id, b] as const)))
  const out = new Set<string>()
  const seen = new Set<string>()
  const follow = (valueId: string) => {
    const b = blocks.get(valueId)
    if (b?.kind !== 'data_value' || seen.has(valueId)) return
    seen.add(valueId)
    const c = b.compute
    switch (c.op) {
      case 'count':
        out.add(c.block)
        return
      case 'sum':
      case 'min':
      case 'max':
        out.add(c.column.block)
        return
      case 'ratio':
      case 'difference':
        for (const r of [c.left, c.right]) if ('value' in r) follow(r.value)
        return
      case 'parameter':
        return
    }
  }
  for (const s of recipe.sections) {
    if (s.version === 'internal') continue
    for (const b of s.blocks) {
      if (b.kind === 'data_table' || b.kind === 'data_list') out.add(b.id)
      else if (b.kind === 'data_value') follow(b.id)
    }
  }
  return out
}
