import { describe, expect, it } from 'vitest'
import { errorKey } from '../src/components/projects/error-message.ts'
import { ApiError } from '../src/lib/api-client.ts'

describe('errorKey', () => {
  it('maps invalid fields and known codes, ignores the rest', () => {
    const known = ['invalidName', 'conflict']
    expect(errorKey(new ApiError(400, 'invalid', 'name'), known)).toBe('invalidName')
    expect(errorKey(new ApiError(400, 'invalid', 'other'), known)).toBeNull()
    expect(errorKey(new ApiError(409, 'conflict'), known)).toBe('conflict')
    expect(errorKey(new ApiError(500, 'internal'), known)).toBeNull()
    expect(errorKey(new Error('x'), known)).toBeNull()
  })
})
