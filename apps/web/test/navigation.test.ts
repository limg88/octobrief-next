import { describe, expect, it } from 'vitest'
import {
  isActive,
  isSection,
  projectEntries,
  projectHref,
  slugFromPath,
} from '../src/components/shell/navigation.ts'

describe('navigation', () => {
  it('builds the project links', () => {
    expect(projectHref('a b')).toBe('/projects/a%20b')
    expect(projectEntries('alpha').map((e) => [e.section, e.href, e.key])).toEqual([
      ['overview', '/projects/alpha', 'p'],
      ['ask', '/projects/alpha/ask', 'c'],
      ['deliverables', '/projects/alpha/deliverables', 'd'],
      ['memory', '/projects/alpha/memory', 'm'],
    ])
  })

  it('marks the active entry', () => {
    const [overview, ask] = projectEntries('alpha')
    if (!overview || !ask) throw new Error('missing entries')
    expect(isActive('/projects/alpha', overview)).toBe(true)
    expect(isActive('/projects/alpha/ask', overview)).toBe(false)
    expect(isActive('/projects/alpha/ask/123', ask)).toBe(true)
    expect(isActive('/projects/alpha/asking', ask)).toBe(false)
  })

  it('reads the slug from a path', () => {
    expect(slugFromPath('/projects/a%20b/ask')).toBe('a b')
    expect(slugFromPath('/')).toBeNull()
  })

  it('recognizes sections', () => {
    expect(isSection('memory')).toBe(true)
    expect(isSection('admin')).toBe(false)
  })
})
