/** A WIQL string literal: single quotes doubled, so a name never ends the literal. */
export function wiqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export interface WiqlScope {
  /** Area paths (`Project\Area\Sub`): an item is under one of them. */
  areas: readonly string[]
  /** Iteration paths: when any, an item is under one of them too. */
  iterations: readonly string[]
  /** Only items changed at or after this instant (to the second, rounded down). */
  changedSince: Date | null
}

/** The instant to the second, as WIQL reads it with `timePrecision=true`. */
function wiqlDate(at: Date): string {
  const second = new Date(Math.floor(at.getTime() / 1000) * 1000)
  return `${second.toISOString().slice(0, 19)}Z`
}

/** The `WHERE` clauses of the perimeter: under one of the areas and one of the iterations. */
function perimeterClauses(scope: Pick<WiqlScope, 'areas' | 'iterations'>): string[] {
  const under = (field: string, paths: readonly string[]) =>
    `(${paths.map((p) => `[${field}] UNDER ${wiqlString(p)}`).join(' OR ')})`
  const where: string[] = []
  if (scope.areas.length > 0) where.push(under('System.AreaPath', scope.areas))
  if (scope.iterations.length > 0) where.push(under('System.IterationPath', scope.iterations))
  return where
}

/**
 * The query of a reconciliation: the ids of every work item under the chosen areas (and
 * iterations), whatever its change date, by id.
 */
export function listQuery(scope: Pick<WiqlScope, 'areas' | 'iterations'>): string {
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE ${perimeterClauses(scope).join(' AND ')}`,
    'ORDER BY [System.Id] ASC',
  ].join(' ')
}

/**
 * The query of a sync: the ids of the work items under the chosen areas (and iterations), changed
 * since the cursor, oldest change first and by id, so that the cursor (change date, id) is a
 * position in this order. The paths are values in literals, never pieces of the query.
 */
export function syncQuery(scope: WiqlScope): string {
  const where = perimeterClauses(scope)
  if (scope.changedSince !== null) {
    where.push(`[System.ChangedDate] >= '${wiqlDate(scope.changedSince)}'`)
  }
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE ${where.join(' AND ')}`,
    'ORDER BY [System.ChangedDate] ASC, [System.Id] ASC',
  ].join(' ')
}
