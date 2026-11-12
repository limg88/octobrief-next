import { describe, expect, it } from 'vitest'
import { DomainError, newId, type ProjectId, parseId } from '../src/recipe/index.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('ids', () => {
  it('parseId accepts a UUID and rejects anything else', () => {
    const id = newId<ProjectId>()
    expect(parseId<ProjectId>(id)).toBe(id)
    try {
      parseId<ProjectId>('not-a-uuid')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('invalid_id')
    }
  })

  it('newId returns a v4 UUID', () => {
    expect(newId<ProjectId>()).toMatch(UUID_V4)
  })
})
