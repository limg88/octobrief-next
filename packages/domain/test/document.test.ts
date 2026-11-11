import { describe, expect, it } from 'vitest'
import {
  canDeleteDocument,
  correctClassification,
  InvalidDocumentError,
  MAX_DOCUMENT_BYTES,
  normalizeFileName,
  retentionCutoff,
  validateUpload,
} from '../src/document.ts'

function reasonOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof InvalidDocumentError) return error.reason
    throw error
  }
  return undefined
}

describe('normalizeFileName', () => {
  it('keeps the last path segment without control characters', () => {
    expect(normalizeFileName('C:\\Users\\pm\\SAL\u0007 ottobre.docx')).toBe('SAL ottobre.docx')
    expect(normalizeFileName('../../etc/passwd')).toBe('passwd')
    expect(normalizeFileName('  verbale.md ')).toBe('verbale.md')
  })

  it('refuses names with nothing usable or too long', () => {
    for (const name of ['', '   ', 'a/..', '.', 'x/', 'a'.repeat(256)]) {
      expect(reasonOf(() => normalizeFileName(name))).toBe('invalid_name')
    }
  })
})

describe('validateUpload', () => {
  it('accepts a file within the limits', () => {
    expect(validateUpload({ fileName: 'nota.txt', sizeBytes: 10 })).toEqual({
      fileName: 'nota.txt',
    })
  })

  it('refuses an empty or oversized file', () => {
    expect(reasonOf(() => validateUpload({ fileName: 'a.txt', sizeBytes: 0 }))).toBe('empty')
    expect(
      reasonOf(() => validateUpload({ fileName: 'a.txt', sizeBytes: MAX_DOCUMENT_BYTES + 1 })),
    ).toBe('too_large')
  })
})

describe('canDeleteDocument', () => {
  const base = { viewerId: 'v', uploaderId: 'u', memberRole: 'member' as const, admin: false }

  it('lets the uploader, the owner and an admin remove a document', () => {
    expect(canDeleteDocument({ ...base, uploaderId: 'v' })).toBe(true)
    expect(canDeleteDocument({ ...base, memberRole: 'owner' })).toBe(true)
    expect(canDeleteDocument({ ...base, memberRole: null, admin: true })).toBe(true)
  })

  it('refuses another member', () => {
    expect(canDeleteDocument(base)).toBe(false)
  })
})

describe('retentionCutoff', () => {
  it('goes back the given number of days', () => {
    expect(retentionCutoff(new Date('2026-11-11T00:00:00Z'), 10)).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    )
  })
})

describe('correctClassification', () => {
  const current = {
    kind: 'generic',
    audience: 'internal',
    audienceSource: 'default',
    uncertain: ['kind', 'audience', 'date'],
  } as const

  it('takes the PM choice and settles the fields the PM set', () => {
    expect(correctClassification(current, { kind: 'status_report', audience: 'client' })).toEqual({
      kind: 'status_report',
      audience: 'client',
      audienceSource: 'pm',
      uncertain: ['date'],
    })
  })

  it('keeps the audience when only the kind changes', () => {
    expect(correctClassification(current, { kind: 'contract' })).toEqual({
      kind: 'contract',
      audience: 'internal',
      audienceSource: 'default',
      uncertain: ['audience', 'date'],
    })
  })

  it('keeps economics internal whatever the PM picks', () => {
    expect(
      correctClassification(current, { kind: 'economics_export', audience: 'client' }),
    ).toEqual({
      kind: 'economics_export',
      audience: 'internal',
      audienceSource: 'rule',
      uncertain: ['date'],
    })
  })
})
