import type { Locator } from '@octobrief/domain'

const KIB = 1024
const MIB = KIB * 1024

/** «12 KB», «3.4 MB»: sizes as people read them. */
export function formatSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`
  if (bytes < MIB) return `${Math.round(bytes / KIB)} KB`
  return `${(bytes / MIB).toFixed(1)} MB`
}

/** The message key and values that name a place in a document. */
export function locatorMessage(locator: Locator): {
  key: Locator['kind']
  values: Record<string, string | number>
} {
  switch (locator.kind) {
    case 'page':
      return { key: 'page', values: { n: locator.page } }
    case 'paragraph':
      return { key: 'paragraph', values: { n: locator.index } }
    case 'slide':
      return { key: 'slide', values: { n: locator.slide } }
    case 'cell':
      return { key: 'cell', values: { sheet: locator.sheet, ref: locator.ref } }
    case 'line':
      return { key: 'line', values: { from: locator.from, to: locator.to } }
  }
}

/** Error codes of a failed upload or delete that have their own message. */
export const MEMORY_ERRORS = [
  'conflict',
  'empty',
  'too_large',
  'invalid_name',
  'forbidden',
] as const
export type MemoryError = (typeof MEMORY_ERRORS)[number]

export function memoryErrorKey(code: string, reason: string | undefined): MemoryError | null {
  const candidate = code === 'invalid' ? reason : code
  return MEMORY_ERRORS.find((key) => key === candidate) ?? null
}
