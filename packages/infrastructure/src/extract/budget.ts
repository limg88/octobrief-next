import { MAX_TEXT_CHARS, MAX_VALUE_CHARS } from './limits.ts'

/**
 * Running count of the characters taken so far. Every format takes each value from it before
 * keeping the value, so that a small file cannot expand into more text than the limit (a huge
 * shared string referenced by many cells, say) and extraction stops as soon as the budget is spent.
 */
export class TextBudget {
  private used = 0
  /** Set when a value was cut or the budget ran out. */
  truncated = false

  /** The value, cut to the per-value limit; `null` when the budget would be exceeded: stop. */
  take(value: string): string | null {
    let text = value
    if (text.length > MAX_VALUE_CHARS) {
      text = text.slice(0, MAX_VALUE_CHARS)
      // Do not end on the first half of a surrogate pair.
      const last = text.charCodeAt(text.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
      this.truncated = true
    }
    if (this.used + text.length > MAX_TEXT_CHARS) {
      this.truncated = true
      return null
    }
    this.used += text.length
    return text
  }
}
