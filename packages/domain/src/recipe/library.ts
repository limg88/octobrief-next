// The library of the Admin as a project sees it: a library recipe used in a project stays pinned
// to its version. A newer published version is a notice to the PM, adopted only by an explicit
// action; a revoked publication stays in use where it is pinned, with a notice, but is no longer
// adopted.

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

function partsOf(version: string): [number, number, number] {
  const match = VERSION.exec(version)
  if (!match) throw new Error('compareRecipeVersions: not a recipe version')
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareRecipeVersions(a: string, b: string): number {
  const x = partsOf(a)
  const y = partsOf(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number)
    if (d !== 0) return d
  }
  return 0
}

/** A published version of a library recipe, as a project sees it. */
export interface PublishedVersion {
  version: string
  revoked: boolean
}

/** What the PM is told about a library recipe pinned in the project. */
export interface LibraryNotice {
  /** The newest published version newer than the pinned one, never a revoked one. */
  newVersion: string | null
  /** The pinned version is no longer published: it stays in use, with the notice. */
  pinnedRevoked: boolean
}

export function libraryNotice(
  pinned: string,
  published: readonly PublishedVersion[],
): LibraryNotice {
  let newest: string | null = null
  for (const p of published) {
    if (p.revoked || compareRecipeVersions(p.version, pinned) <= 0) continue
    if (newest === null || compareRecipeVersions(p.version, newest) > 0) newest = p.version
  }
  const own = published.find((p) => p.version === pinned)
  return { newVersion: newest, pinnedRevoked: own === undefined || own.revoked }
}
