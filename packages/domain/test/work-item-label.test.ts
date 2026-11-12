import { describe, expect, it } from 'vitest'
import { workItemLabel } from '../src/recipe/index.ts'

// How a work item named by another (a feature, a parent) is shown in a document: by its title,
// with its id beside it; when its title was not read, its id and that it was not read, never a
// title made up.

describe('the label of a work item', () => {
  it('a feature is shown by its title', () => {
    expect(workItemLabel('29736', { summary: 'Accesso con SSO' }, 'it')).toBe(
      'Accesso con SSO (29736)',
    )
  })

  it('says the title was not read when the tracker gave none, never makes one up', () => {
    expect(workItemLabel('29736', undefined, 'it')).toBe('29736 (titolo non letto)')
    expect(workItemLabel('29736', { summary: null }, 'it')).toBe('29736 (titolo non letto)')
    expect(workItemLabel('29736', { summary: '   ' }, 'it')).toBe('29736 (titolo non letto)')
  })
})
