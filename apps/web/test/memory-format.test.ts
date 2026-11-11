import { describe, expect, it } from 'vitest'
import { formatSize, locatorMessage, memoryErrorKey } from '@/components/memory/format'

describe('memory formatting', () => {
  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })

  it('names places in a document', () => {
    expect(locatorMessage({ kind: 'paragraph', index: 4 })).toEqual({
      key: 'paragraph',
      values: { n: 4 },
    })
    expect(locatorMessage({ kind: 'slide', slide: 2 })).toEqual({ key: 'slide', values: { n: 2 } })
  })

  it('maps error codes and invalid reasons to messages', () => {
    expect(memoryErrorKey('conflict', undefined)).toBe('conflict')
    expect(memoryErrorKey('invalid', 'empty')).toBe('empty')
    expect(memoryErrorKey('too_large', undefined)).toBe('too_large')
    expect(memoryErrorKey('internal', undefined)).toBeNull()
  })
})
