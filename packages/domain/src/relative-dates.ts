import type { Lang } from './language/index.ts'
import { isCalendarDate, romeDateString, romeMidnight } from './rome-time.ts'

// A relative time in a document («domani», «martedì prossimo», «fine mese», «a settembre») names
// a day or a month only against the date of the document. When that date is certain, the compile
// may write it in full; these are what it may write, so that a number of a resolved date is still
// a number with a source (the excerpt that says it and the date of the document). A day only when
// the expression fixes it; a vague time (a month, a week, a weekday alone) gives a month and year
// at most, never a guessed day; and nothing without a certain date.

/** A calendar day in Italy. */
interface Day {
  y: number
  m: number
  d: number
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  lunedì: 1,
  lunedi: 1,
  martedì: 2,
  martedi: 2,
  mercoledì: 3,
  mercoledi: 3,
  giovedì: 4,
  giovedi: 4,
  venerdì: 5,
  venerdi: 5,
  sabato: 6,
  domenica: 0,
}

const MONTHS: readonly string[] = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
]

/** Longest text read: an excerpt is at most a few hundred characters. */
const MAX_TEXT = 4_000
/** Farthest «fra N giorni / settimane» taken. */
const MAX_AHEAD_DAYS = 400

const WORD = (w: string) => new RegExp(`(?<![\\p{L}\\d])${w}(?![\\p{L}\\d])`, 'iu')
const TODAY = WORD('oggi')
const TOMORROW = WORD('domani')
const AFTER_TOMORROW = WORD('dopodomani')
const YESTERDAY = WORD('ieri')
const NEXT_WEEK = /(?<![\p{L}])(?:settimana\s+prossima|prossima\s+settimana)(?![\p{L}])/iu
const THIS_WEEK =
  /(?<![\p{L}])(?:questa\s+settimana|settimana\s+corrente|entro\s+la\s+settimana)(?![\p{L}])/iu
const WEEKEND = /(?<![\p{L}])(?:fine\s+settimana|weekend)(?![\p{L}])/iu
const END_OF_MONTH = /(?<![\p{L}])fine\s+(?:del\s+)?mese(?![\p{L}])/iu
const NEXT_MONTH = /(?<![\p{L}])(?:mese\s+prossimo|prossimo\s+mese)(?![\p{L}])/iu
const IN_DAYS =
  /(?<![\p{L}])(?:fra|tra)\s+(\d{1,3})\s+(giorni|giorno|settimane|settimana)(?![\p{L}])/giu
const MONTH_NAME =
  /(?<![\p{L}])(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?![\p{L}])(?!\s*\d{4})/giu

function dayOf(at: Date): Day {
  const [y, m, d] = romeDateString(at).split('-').map(Number) as [number, number, number]
  return { y, m, d }
}

function plus(day: Day, days: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + days))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

const weekday = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()

function lastDay(y: number, m: number): number {
  for (let d = 31; d >= 28; d--) if (isCalendarDate(y, m, d)) return d
  return 28
}

/** A weekday with what fixes it: «martedì prossimo», «il prossimo martedì», «lunedì scorso». */
const WEEKDAY_FIXED =
  /(?<![\p{L}])(?:(prossim[oa]|scors[oa])\s+)?(lunedì|lunedi|martedì|martedi|mercoledì|mercoledi|giovedì|giovedi|venerdì|venerdi|sabato|domenica)(?:\s+(prossim[oa]|scors[oa]))?(?![\p{L}])/giu

/** What relative times name against the certain date of a document. */
export interface RelativeTimes {
  /** Days named uniquely: a statement may write them in full. */
  days: Date[]
  /** Months (`yyyy-mm`) named without a day: a statement may write the month and the year only. */
  months: string[]
}

/**
 * What the relative times written in `text` name, against the certain date of its document
 * (`anchor`). A day only when the expression fixes it: today, tomorrow, the day after, yesterday,
 * «fra N giorni / settimane», the end of this month, a weekday with «prossimo» or «scorso». A
 * month only (no day) for a month named without a year (from the month of the document on, in its
 * year; before it, in its year or the next: the text may tell of a month past or ahead), the next
 * month, a week (this one, the next, the weekend) and a weekday alone: the month
 * and year of every day it may be. Empty when the text says none of these.
 */
export function relativeTimes(text: string, anchor: Date, lang: Lang): RelativeTimes {
  if (lang !== 'it') return { days: [], months: [] }
  const t = text.slice(0, MAX_TEXT)
  const today = dayOf(anchor)
  const days = new Map<string, Day>()
  const months = new Set<string>()
  const add = (day: Day) => {
    if (isCalendarDate(day.y, day.m, day.d)) days.set(`${day.y}-${day.m}-${day.d}`, day)
  }
  const monthOf = (y: number, m: number) => months.add(`${y}-${String(m).padStart(2, '0')}`)
  const monthsOfRange = (from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      const d = plus(today, i)
      monthOf(d.y, d.m)
    }
  }
  if (TODAY.test(t)) add(today)
  if (AFTER_TOMORROW.test(t)) add(plus(today, 2))
  if (TOMORROW.test(t)) add(plus(today, 1))
  if (YESTERDAY.test(t)) add(plus(today, -1))
  if (END_OF_MONTH.test(t)) add({ y: today.y, m: today.m, d: lastDay(today.y, today.m) })
  for (const m of t.matchAll(IN_DAYS)) {
    const n = Number(m[1])
    const ahead = (m[2] as string).toLowerCase().startsWith('settiman') ? n * 7 : n
    if (ahead <= MAX_AHEAD_DAYS) add(plus(today, ahead))
  }
  const toMonday = (weekday(today) + 6) % 7
  if (THIS_WEEK.test(t)) monthsOfRange(-toMonday, 6 - toMonday)
  if (NEXT_WEEK.test(t)) monthsOfRange(7 - toMonday, 13 - toMonday)
  if (WEEKEND.test(t)) monthsOfRange(4 - toMonday, 6 - toMonday)
  if (NEXT_MONTH.test(t)) {
    if (today.m === 12) monthOf(today.y + 1, 1)
    else monthOf(today.y, today.m + 1)
  }
  for (const m of t.matchAll(WEEKDAY_FIXED)) {
    const wanted = WEEKDAYS[(m[2] as string).toLowerCase()] as number
    const fixer = (m[1] ?? m[3] ?? '').toLowerCase()
    const ahead = (wanted - weekday(today) + 7) % 7
    if (fixer.startsWith('prossim')) add(plus(today, ahead === 0 ? 7 : ahead))
    else if (fixer.startsWith('scors')) add(plus(today, ahead === 0 ? -7 : ahead - 7))
    else for (const offset of [ahead - 7, ahead, ahead + 7]) monthsOfRange(offset, offset)
  }
  for (const m of t.matchAll(MONTH_NAME)) {
    // A month from that of the document on is in its year. A month before it may be past («a
    // marzo abbiamo consegnato» in June: March of the year of the document) or ahead («entro
    // marzo»: the March after): both are candidates, as a month and year only.
    const named = MONTHS.indexOf((m[1] as string).toLowerCase()) + 1
    monthOf(today.y, named)
    if (named < today.m) monthOf(today.y + 1, named)
  }
  return {
    days: [...days.values()].map((day) => romeMidnight(day.y, day.m, day.d)),
    months: [...months],
  }
}

/** The days the relative times of `text` name uniquely (`relativeTimes`). */
export function relativeDates(text: string, anchor: Date, lang: Lang): Date[] {
  return relativeTimes(text, anchor, lang).days
}

// Whole date expressions a statement may write: «5/6/2026» (also with «-» or «.»), «2026-06-05»,
// «5 giugno 2026» (or «1° giugno 2026»), and a month with its year, «settembre 2026». Linear:
// bounded digit groups, one alternation of words.
const DAY_MONTH_YEAR_DIGITS = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?![\d/.-])/g
const ISO_DATE = /(?<![\d/.-])(\d{4})-(\d{2})-(\d{2})(?![\d/.-])/g
const DAY_MONTH_NAME_YEAR =
  /(?<![\p{L}\d])(\d{1,2})[°º]?\s(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s(\d{4})(?!\d)/giu
/** A month and its year with no day before it (a day before it makes it a whole date). */
const MONTH_NAME_YEAR =
  /(?<![\p{L}\d])(?<!\d[°º]?\s)(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s(\d{4})(?!\d)/giu

/**
 * The text without the whole dates it writes that a relative time of the excerpts names against
 * the certain date of the document (`anchor`): a day in full only when a relative time fixes that
 * day, a month with its year (no day) when a relative time names that month. Each is accepted as
 * a whole and taken out, so the rest of the text is checked against the excerpts alone
 * (`numbersCited`). A date that no relative time names stays, and its numbers need an excerpt
 * that shows them: a day guessed from «a settembre» or from a weekday alone has no source.
 */
export function withoutResolvedDates(
  text: string,
  excerpts: readonly string[],
  anchor: Date,
  lang: Lang,
): string {
  const named = relativeTimes(excerpts.join('\n'), anchor, lang)
  const days = new Set(named.days.map((at) => romeDateString(at)))
  const months = new Set(named.months)
  if (days.size === 0 && months.size === 0) return text
  const pad = (n: number) => String(n).padStart(2, '0')
  const strip = (whole: string, y: number, m: number, d: number) =>
    isCalendarDate(y, m, d) && days.has(`${y}-${pad(m)}-${pad(d)}`) ? ' ' : whole
  return text
    .replace(ISO_DATE, (whole, y, m, d) => strip(whole, Number(y), Number(m), Number(d)))
    .replace(DAY_MONTH_YEAR_DIGITS, (whole, d, _sep, m, y) =>
      strip(whole, Number(y), Number(m), Number(d)),
    )
    .replace(DAY_MONTH_NAME_YEAR, (whole, d, name: string, y) =>
      strip(whole, Number(y), MONTHS.indexOf(name.toLowerCase()) + 1, Number(d)),
    )
    .replace(MONTH_NAME_YEAR, (whole, name: string, y) =>
      months.has(`${y}-${pad(MONTHS.indexOf(name.toLowerCase()) + 1)}`) ? ' ' : whole,
    )
}
