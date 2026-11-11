import { attr, decodeXml, tags } from './xml.ts'

/** Relationship id to target, from an Office `.rels` part. */
export function relationships(rels: Uint8Array | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!rels) return map
  for (const attrs of tags(decodeXml(rels), 'Relationship')) {
    const id = attr(attrs, 'Id')
    const target = attr(attrs, 'Target')
    if (id && target) map.set(id, target)
  }
  return map
}

/** Resolves a relationship target against the folder of the part that owns the `.rels`. */
export function resolveTarget(folder: string, target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `${folder}/${target}`
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') out.pop()
    else if (segment !== '.' && segment !== '') out.push(segment)
  }
  return out.join('/')
}
