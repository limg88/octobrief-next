// The kinds of source a recipe names in its prerequisites and in the provenance of what it
// reads. A recipe is portable between installations, so these names are fixed here and the
// sources of a project are mapped onto them (`recipeSourceKind`).
export const SOURCE_KINDS = [
  'manual_upload',
  'ado',
  'jira',
  'teams',
  'mail',
  'sharepoint',
  'netsuite_dwsi',
  'local_folder',
] as const

export type SourceKind = (typeof SOURCE_KINDS)[number]

/**
 * Whether the evidence of a source is system data whose kind the system decides: the data
 * warehouse (hours and economics). Its kind never changes and it is internal.
 */
export function isSystemDataSource(sourceKind: SourceKind): boolean {
  return sourceKind === 'netsuite_dwsi'
}

/** How a source of a project is called in a recipe; a manual upload when there is none. */
export function recipeSourceKind(
  kind: 'm365' | 'dwsi' | 'files' | 'jira' | 'ado' | null,
): SourceKind {
  switch (kind) {
    case 'm365':
      return 'mail'
    case 'dwsi':
      return 'netsuite_dwsi'
    case 'files':
      return 'local_folder'
    case null:
      return 'manual_upload'
    default:
      return kind
  }
}
