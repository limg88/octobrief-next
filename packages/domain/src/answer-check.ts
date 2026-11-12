import type { AnswerSourceRef, ModelAnswer, Nature } from './answer.ts'
import { canonicalText, hasMixedScript } from './canonical.ts'
import type { DateSource } from './document-date.ts'
import { isLocator, locatorKey } from './extraction.ts'
import {
  type FreshnessPolicy,
  type FreshnessThresholds,
  type SourceFreshnessLevel,
  sourceFreshnessOf,
  tightenFreshness,
} from './freshness.ts'
import type { EvidenceId, FactId, SourceId } from './ids.ts'
import type { Lang } from './language/index.ts'
import { vocabulary } from './language/index.ts'
import {
  type ClaimedNumber,
  claimedNumberSpans,
  type DataKind,
  dataKindsIn,
  hasNumberWords,
  numberText,
} from './numbers.ts'
import type { ReadLog } from './read-log.ts'
import { dayForms, isTrackerLocator, parseCalendarDay, trackerLocatorKey } from './tracker.ts'

/**
 * What storage knows of a source: its title and its registered date, never the model's.
 * `sourceDate` is `null` for system data its system did not date: its age cannot be judged.
 */
export interface RegisteredSource {
  title: string
  sourceDate: Date | null
  dateSource: DateSource
  /** Only `system` data is judged by the thresholds; a document is only dated. */
  freshnessPolicy: FreshnessPolicy
  /** A document of the same kind with a later date is in the project (never system data). */
  superseded: boolean
}

/**
 * What storage knows of a tracker source: its name and up to when its connector read the system
 * (system data). `sourceDate` is `null` when no sync has said it: its age cannot be judged.
 */
export type RegisteredTracker = RegisteredSource

/**
 * What storage knows of a fact: as a source, plus whether the PM stated it or sources disagree.
 * A fact stated by the PM follows the document policy, whatever its policy says.
 */
export interface RegisteredFact extends RegisteredSource {
  pmAsserted: boolean
  /** The sources of the fact disagree: an open contradiction waits for the PM in the inbox. */
  contested: boolean
}

/**
 * The sources of the project, as registered. For a fact, `sourceDate` is the date of its latest
 * source evidence; a fact stated by the PM («indicato dal PM») is a source of its own, dated by
 * the PM. `null` means «not found or not visible».
 */
export interface SourceRegistry {
  evidence(id: EvidenceId): RegisteredSource | null
  fact(id: FactId): RegisteredFact | null
  /**
   * A tracker source of the project: its name and up to when its connector read the system
   * (system data, judged by the thresholds).
   */
  tracker(id: SourceId): RegisteredTracker | null
}

export interface VerifyContext {
  /** The language of the run: the recognizers use it, whatever the model declares. */
  lang: Lang
  read: ReadLog
  registry: SourceRegistry
  /** The project thresholds; looser than the defaults is refused (`tightenFreshness`). */
  thresholds: FreshnessThresholds
  now: Date
  /**
   * Names of people and organizations of the project: a sentence about them needs a source.
   * Matched as whole words, ignoring case and accents, after `canonicalText`; a name is found only
   * as written here, so callers pass each form they want caught (full name, surname alone, …).
   */
  knownNames: readonly string[]
  /** Names that count only written with a capital (the parts of an outsider's name). */
  capitalNames?: readonly string[]
}

export type UnverifiedReason = 'not_read' | 'unknown_source' | 'numbers_not_in_source'

export interface VerifiedSource {
  /** The citation as the contract allows it: nothing else the model wrote is kept. */
  ref: AnswerSourceRef
  verified: boolean
  reason: UnverifiedReason | null
  /** From the registry; `null` when the registry does not know the source. */
  title: string | null
  sourceDate: Date | null
  dateSource: DateSource | null
  pmAsserted: boolean
  /** A fact whose sources disagree: shown with «Le fonti non sono d'accordo». */
  contested: boolean
  /** The registered date is more than a day ahead of now: its freshness cannot be judged. */
  futureDate: boolean
  /** How its age is judged: thresholds for `system` data, the date alone for a `document`. */
  freshnessPolicy: FreshnessPolicy
  /** A newer document of the same kind is in the project: shown, never an anomaly. */
  superseded: boolean
  /**
   * Only for a verified source with a plausible date. A document is always `dated`; a source of
   * system data is `fresh`, `warning` or `stale` by the thresholds.
   */
  freshness: { level: SourceFreshnessLevel; ageHours: number } | null
}

/** `dated` when every judged source is a document; `unknown` without any. */
export type SegmentFreshness = SourceFreshnessLevel | 'unknown'

export type SuspendedReason = 'without_source' | 'stale_data' | 'unknown_freshness'

/** `superseded` is a note, not an anomaly: a newer document of the same kind exists. */
export type FreshnessWarning = 'to_recheck' | 'stale' | 'superseded'

export interface VerifiedSegment {
  /** What can be shown (canonical); `null` when suspended (the UI shows the PM message). */
  text: string | null
  /** The canonical text of the model, kept for audit only. */
  originalText: string
  nature: Nature
  sources: VerifiedSource[]
  /** Carries data, a known name, or is stated as a fact: it needs a verified source. */
  inScope: boolean
  dataKinds: DataKind[]
  mentionsKnownName: boolean
  /** A word mixes Latin with Cyrillic or Greek letters: in scope, and an anomaly. */
  mixedScript: boolean
  withoutSource: boolean
  /**
   * The worst level among the verified sources with a plausible date (a document counts as
   * `dated`, below every judged level); `unknown` without any.
   */
  freshness: SegmentFreshness
  warning: FreshnessWarning | null
  /** A verified source is a contested fact: the text stays, with the warning and an anomaly. */
  contested: boolean
  /** The text is suspended, for `suspendedReason`. */
  numbersSuspended: boolean
  /**
   * `without_source` wins over `stale_data`; `unknown_freshness` when the only verified sources
   * have a date more than a day ahead, or are trackers of unknown age (fail closed).
   */
  suspendedReason: SuspendedReason | null
}

export interface VerifiedSide {
  /** Shown only with a verified source, and not stale when it carries data or a known name. */
  value: string | null
  originalValue: string
  source: VerifiedSource
  freshness: SegmentFreshness
  warning: FreshnessWarning | null
  suspendedReason: SuspendedReason | null
}

export interface VerifiedContradiction {
  /** `null` when the subject or the reason carries data, a known name or mixed scripts. */
  subject: string | null
  reason: string | null
  originalSubject: string
  originalReason: string
  suppressed: boolean
  /** Every side, in the model's order: a contradiction is shown, never resolved. */
  sides: VerifiedSide[]
  allSidesVerified: boolean
  sameDocument: boolean
}

export interface VerifiedAbsence {
  /** `null` when the question or the proposal carries data, a name or mixed scripts. */
  question: string | null
  proposal: string | null
  originalQuestion: string
  originalProposal: string
  suppressed: boolean
}

export const ANSWER_ANOMALY_CODES = [
  'lang_mismatch',
  'without_source',
  'stale_data',
  'future_source_date',
  'unknown_source_freshness',
  'mixed_script',
  'contradiction_unverified_side',
  'contradiction_stale_side',
  'contradiction_with_data',
  'contradiction_with_name',
  'contradiction_with_mixed_script',
  'same_document_contradiction',
  'contested_source',
  'absence_with_data',
  'absence_with_name',
  'absence_with_mixed_script',
] as const
export type AnswerAnomalyCode = (typeof ANSWER_ANOMALY_CODES)[number]

export interface AnswerAnomaly {
  code: AnswerAnomalyCode
  /** Index of the segment, contradiction or absence (0 for `lang_mismatch`). */
  index: number
  /** For an anomaly of one side of a contradiction: the side. */
  side?: number
}

export interface VerifiedAnswer {
  lang: Lang
  segments: VerifiedSegment[]
  contradictions: VerifiedContradiction[]
  absences: VerifiedAbsence[]
  /** «N verifiche, M anomalie», with the anomalies listed for audit and UI. */
  checks: { total: number; anomalies: number; list: AnswerAnomaly[] }
}

// Checks counted: 1 for the language; per segment source (with its numbers), scope, freshness;
// per side of a contradiction source and freshness; per contradiction same document and data in
// its subject or reason; per absence data in its texts.
const CHECKS_PER_SEGMENT = 3
const CHECKS_PER_SIDE = 2
const CHECKS_PER_CONTRADICTION = 2

const DAY_MS = 24 * 3_600_000

const LEVEL_RANK: Readonly<Record<SourceFreshnessLevel, number>> = {
  dated: 0,
  fresh: 1,
  warning: 2,
  stale: 3,
}

const WORD = '[\\p{L}\\p{N}\\p{M}]'
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/gu

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Canonical, lowercase and without accents: «Niccolò» and «NICCOLO» compare equal. */
function foldForNames(text: string): string {
  return canonicalText(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC')
}

/** Matchers of the known names as whole words, ignoring case and accents. */
function nameMatcher(
  names: readonly string[],
  capitalNames: readonly string[],
  _lang: Lang,
): (text: string) => boolean {
  const patterns = [...new Set(names.map(foldForNames).filter((n) => n !== ''))].map(
    (n) => new RegExp(`(?<!${WORD})${escapeRegExp(n)}(?!${WORD})`, 'u'),
  )
  // Written with a capital: each word run of the canonical text whose first letter is a capital,
  // folded and looked up (linear in the text; «Fantìni» and «FANTINI» count for «Fantini»).
  const capitals = new Set(capitalNames.map(foldForNames).filter((n) => n !== ''))
  return (text) => {
    const folded = foldForNames(text)
    if (patterns.some((p) => p.test(folded))) return true
    if (capitals.size === 0) return false
    for (const [run] of canonicalText(text).matchAll(WORD_RUN)) {
      if (/^\p{Lu}/u.test(run) && capitals.has(foldForNames(run))) return true
    }
    return false
  }
}

/**
 * Whether the name of a group can stand as a label: it has letters and no number in words
 * («Sprint Alpha», «Sprint 12»; never «15», «26.1» nor «Due»), so a label never holds a number
 * that a sentence could claim through it.
 */
function usableLabel(label: string, lang: Lang): boolean {
  return /\p{L}/u.test(label) && !hasNumberWords(label, lang)
}

/** The reads of the run, as lookups, with the numbers shown at each place. */
function readIndex(log: ReadLog, lang: Lang) {
  const evidence = new Map<EvidenceId, Map<string, ReadonlySet<string>>>()
  const facts = new Map<FactId, ReadonlySet<string>>()
  const trackers = new Map<SourceId, Map<string, ReadonlySet<string>>>()
  const trackerLabels = new Map<SourceId, Map<string, ReadonlySet<string>>>()
  const trackerDays = new Map<SourceId, Map<string, ReadonlySet<string>>>()
  for (const entry of log.entries) {
    if ('factId' in entry) {
      facts.set(entry.factId, new Set([...(facts.get(entry.factId) ?? []), ...entry.numbers]))
      continue
    }
    if ('trackerSourceId' in entry) {
      const places = trackers.get(entry.trackerSourceId) ?? new Map<string, ReadonlySet<string>>()
      const labels =
        trackerLabels.get(entry.trackerSourceId) ?? new Map<string, ReadonlySet<string>>()
      const dayMap =
        trackerDays.get(entry.trackerSourceId) ?? new Map<string, ReadonlySet<string>>()
      for (const { locator, numbers, labels: names, days } of entry.reads) {
        const key = trackerLocatorKey(locator)
        places.set(key, new Set([...(places.get(key) ?? []), ...numbers]))
        const usable = (names ?? []).filter((n) => usableLabel(n, lang))
        labels.set(key, new Set([...(labels.get(key) ?? []), ...usable]))
        const valid = (days ?? []).filter((d) => parseCalendarDay(d) !== null)
        dayMap.set(key, new Set([...(dayMap.get(key) ?? []), ...valid]))
      }
      trackers.set(entry.trackerSourceId, places)
      trackerLabels.set(entry.trackerSourceId, labels)
      trackerDays.set(entry.trackerSourceId, dayMap)
      continue
    }
    const places = evidence.get(entry.evidenceId) ?? new Map<string, ReadonlySet<string>>()
    for (const { locator, numbers } of entry.reads) {
      const key = locatorKey(locator)
      places.set(key, new Set([...(places.get(key) ?? []), ...numbers]))
    }
    evidence.set(entry.evidenceId, places)
  }
  return { evidence, facts, trackers, trackerLabels, trackerDays }
}

type ReadIndex = ReturnType<typeof readIndex>

interface Checked {
  source: VerifiedSource
  /** The numbers the model was shown in this source, if it read it. */
  numbers: ReadonlySet<string>
  /** The names of the groups a tracker showed with them: their digits are part of a name. */
  labels: ReadonlySet<string>
  /** The days (`yyyy-mm-dd`) a tracker's counts were shown as of. */
  days: ReadonlySet<string>
}

interface Env {
  read: ReadIndex
  ctx: VerifyContext
  thresholds: FreshnessThresholds
}

const NONE: ReadonlySet<string> = new Set()

function verifySource(ref: AnswerSourceRef, env: Env): Checked {
  const { read, ctx } = env
  let clean: AnswerSourceRef
  let registered: RegisteredFact | null
  let numbers: ReadonlySet<string> | undefined
  let labels: ReadonlySet<string> = NONE
  let days: ReadonlySet<string> = NONE
  if ('factId' in ref) {
    clean = { factId: ref.factId }
    registered = ctx.registry.fact(ref.factId)
    numbers = read.facts.get(ref.factId)
  } else if ('sourceId' in ref) {
    clean = { sourceId: ref.sourceId, locator: ref.locator }
    const tracker = ctx.registry.tracker(ref.sourceId)
    registered = tracker && { ...tracker, pmAsserted: false, contested: false }
    const key = isTrackerLocator(ref.locator) ? trackerLocatorKey(ref.locator) : null
    numbers = key === null ? undefined : read.trackers.get(ref.sourceId)?.get(key)
    labels = (key === null ? undefined : read.trackerLabels.get(ref.sourceId)?.get(key)) ?? NONE
    days = (key === null ? undefined : read.trackerDays.get(ref.sourceId)?.get(key)) ?? NONE
  } else {
    clean = { evidenceId: ref.evidenceId, locator: ref.locator }
    const evidence = ctx.registry.evidence(ref.evidenceId)
    registered = evidence && { ...evidence, pmAsserted: false, contested: false }
    numbers = isLocator(ref.locator)
      ? read.evidence.get(ref.evidenceId)?.get(locatorKey(ref.locator))
      : undefined
  }
  if (!registered) {
    return {
      source: {
        ref: clean,
        verified: false,
        reason: 'unknown_source',
        title: null,
        sourceDate: null,
        dateSource: null,
        pmAsserted: false,
        contested: false,
        futureDate: false,
        freshnessPolicy: 'document',
        superseded: false,
        freshness: null,
      },
      numbers: NONE,
      labels: NONE,
      days: NONE,
    }
  }
  const { title, sourceDate, pmAsserted } = registered
  const wasRead = numbers !== undefined
  const futureDate = sourceDate !== null && sourceDate.getTime() > ctx.now.getTime() + DAY_MS
  // What the PM stated is a document of the PM; only a document can be superseded.
  const freshnessPolicy: FreshnessPolicy = pmAsserted ? 'document' : registered.freshnessPolicy
  const superseded = freshnessPolicy === 'document' && !pmAsserted && registered.superseded
  return {
    source: {
      ref: clean,
      verified: wasRead,
      reason: wasRead ? null : 'not_read',
      title,
      sourceDate,
      // A fact stated by the PM is dated by the PM, whatever its evidence says.
      dateSource: pmAsserted ? 'pm' : registered.dateSource,
      pmAsserted,
      contested: registered.contested,
      futureDate,
      freshnessPolicy,
      superseded,
      freshness:
        wasRead && !futureDate && sourceDate !== null
          ? sourceFreshnessOf(sourceDate, ctx.now, env.thresholds, freshnessPolicy)
          : null,
    },
    numbers: numbers ?? NONE,
    labels: numbers === undefined ? NONE : labels,
    days: numbers === undefined ? NONE : days,
  }
}

/**
 * Every number the text claims (digits, and numbers in words next to a measure) must be backed by
 * its verified sources. A number written inside a label of a source (the name of a group, the day
 * of the counts) and not followed by a measure is excused by that source: a label never stands in
 * for a quantity. A source that excuses a number of the text must on its own cover every number
 * of it, among the numbers it showed or inside its labels, so the day or the group of one source
 * is never paired with the count of another. Without any such excuse each number must be among
 * the numbers the verified sources showed together. Otherwise none of them supports the text,
 * and they are all marked as such.
 */
function requireNumbers(text: string, checked: readonly Checked[], lang: Lang): VerifiedSource[] {
  const verified = checked.filter((c) => c.source.verified)
  const claims = claimedNumberSpans(text, lang)
  const plain = numberText(text)
  const excusedBy = (c: Checked) => {
    const spans = labelSpans(plain, c, claims, lang)
    return (n: ClaimedNumber) =>
      spans.some((s) => s.start <= n.start && n.end <= s.end) && !measureAfter(plain, n.end, lang)
  }
  const excusing = verified
    .map((c) => ({ c, excused: excusedBy(c) }))
    .filter(({ excused }) => claims.some(excused))
  const backed =
    excusing.length > 0
      ? excusing.every(({ c, excused }) =>
          claims.every((n) => c.numbers.has(n.value) || excused(n)),
        )
      : claims.every((n) => verified.some((c) => c.numbers.has(n.value)))
  if (claims.length === 0 || backed) return checked.map((c) => c.source)
  return checked.map(({ source }) =>
    source.verified
      ? { ...source, verified: false, reason: 'numbers_not_in_source', freshness: null }
      : source,
  )
}

/** Whether a measure («work item», «ore», «punti», «%») follows offset `end` of `plain`. */
function measureAfter(plain: string, end: number, lang: Lang): boolean {
  const vocab = vocabulary(lang)
  const next = /^\s*([\p{L}\p{M}\p{N}]+|[€%])(?:\s+([\p{L}\p{M}\p{N}]+))?/u.exec(plain.slice(end))
  if (!next) return false
  const [, first = '', second = ''] = next
  return (
    vocab.MEASURE_WORDS.has(first) ||
    vocab.MEASURE_PAIRS.some(([a, b]) => a === first && b === second)
  )
}

const YEAR = /^(?:19|20)\d{2}$/

/** Whole-word places of `needle` in `plain`. */
function placesOf(plain: string, needle: string): Array<{ start: number; end: number }> {
  const text = numberText(needle)
  if (text === '') return []
  const re = new RegExp(`(?<!${WORD})${escapeRegExp(text)}(?!${WORD})`, 'gu')
  return [...plain.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/**
 * Where the labels of one citation are written in `plain` (as `numberText` gives it): its group
 * names, and its days in their forms with the year. A form without the year («1 ottobre») counts
 * only when every year the text claims is the year of that day.
 */
function labelSpans(
  plain: string,
  c: Checked,
  claims: readonly ClaimedNumber[],
  lang: Lang,
): Array<{ start: number; end: number }> {
  const out = [...c.labels].flatMap((label) => placesOf(plain, label))
  const years = claims.filter((n) => YEAR.test(n.value)).map((n) => n.value)
  for (const day of c.days) {
    const forms = dayForms(day, lang)
    out.push(...forms.withYear.flatMap((f) => placesOf(plain, f)))
    if (years.every((y) => y === day.slice(0, 4))) {
      out.push(...forms.yearless.flatMap((f) => placesOf(plain, f)))
    }
  }
  return out
}

/** A verified source whose age cannot be judged: dated ahead, or of unknown age. */
const unjudged = (s: VerifiedSource) => s.futureDate || s.sourceDate === null

/**
 * The worst level among the verified sources with a plausible date: a future-dated source never
 * masks a stale one. `onlyFuture` when the age of no verified source can be judged (dated more
 * than a day ahead, or of unknown age).
 */
function freshnessOfSources(sources: readonly VerifiedSource[]): {
  freshness: SegmentFreshness
  onlyFuture: boolean
} {
  const verified = sources.filter((s) => s.verified)
  let worst: SegmentFreshness = 'unknown'
  for (const s of verified) {
    if (!s.freshness) continue
    const level = s.freshness.level
    if (worst === 'unknown' || LEVEL_RANK[level] > LEVEL_RANK[worst]) worst = level
  }
  return {
    freshness: worst,
    onlyFuture: verified.length > 0 && verified.every(unjudged),
  }
}

type TextProblem = 'data' | 'name' | 'mixed_script'

/** Which problem a text outside the segments has, if any: data first, then names, then scripts. */
function textProblem(
  texts: readonly string[],
  hasData: (t: string) => boolean,
  mentionsName: (t: string) => boolean,
): TextProblem | null {
  if (texts.some(hasData)) return 'data'
  if (texts.some(mentionsName)) return 'name'
  if (texts.some(hasMixedScript)) return 'mixed_script'
  return null
}

const CONTRADICTION_CODE: Readonly<Record<TextProblem, AnswerAnomalyCode>> = {
  data: 'contradiction_with_data',
  name: 'contradiction_with_name',
  mixed_script: 'contradiction_with_mixed_script',
}

const ABSENCE_CODE: Readonly<Record<TextProblem, AnswerAnomalyCode>> = {
  data: 'absence_with_data',
  name: 'absence_with_name',
  mixed_script: 'absence_with_mixed_script',
}

/**
 * The age warning of the system data first; otherwise `superseded` when every verified source is
 * a superseded document (a current source among them says the data is still the latest).
 */
function warningOf(
  freshness: SegmentFreshness,
  sources: readonly VerifiedSource[],
): FreshnessWarning | null {
  if (freshness === 'stale') return 'stale'
  if (freshness === 'warning') return 'to_recheck'
  const verified = sources.filter((s) => s.verified)
  if (verified.length > 0 && verified.every((s) => s.superseded)) return 'superseded'
  return null
}

/** What a side stands on: a document, a fact, or one work item (or the counts) of a tracker. */
const identity = (ref: AnswerSourceRef) => {
  if ('factId' in ref) return `fact:${ref.factId}`
  if ('sourceId' in ref) {
    const place = ref.locator.kind === 'work_item' ? `work_item:${ref.locator.id}` : 'counts'
    return `tracker:${ref.sourceId}:${place}`
  }
  return `evidence:${ref.evidenceId}`
}

/**
 * Checks an answer of the model against what the run has read and what is registered. Every text
 * is checked and shown in its canonical form.
 * - A source is verified only if it was read (the evidence at that locator, the fact, or the
 *   work item, its field or the counts of a tracker as the tool showed them), the registry knows
 *   it and, for a text with numbers, every number is among those it showed. Title and date always
 *   come from the registry; a tracker is dated by the health of its connector (system data).
 * - A segment with data, a known name, a word of mixed scripts, or stated as a fact is in scope;
 *   without a verified source its text is suspended («senza fonte»).
 * - Its freshness is the worst of its verified sources, measured on the registered date (a date
 *   more than a day ahead does not count). The thresholds judge system data only: beyond the stop
 *   an in-scope segment is suspended; a qualitative one stays, with the warning. A document is
 *   only dated, and marked when a newer one of its kind exists. With only future-dated sources, or
 *   trackers of unknown age (an anomaly), the segment is suspended too.
 * - A segment citing a fact whose sources disagree keeps its text, marked `contested`, and the
 *   anomaly is counted: the PM decides in the inbox.
 * - A side of a contradiction is shown only with a verified source, and not when stale with data;
 *   sides from one source are an anomaly; contradictions are shown, never resolved.
 * - An absence, or the subject or reason of a contradiction, carrying data, a known name or mixed
 *   scripts is suppressed: no data enters outside a cited segment.
 */
export function verifyAnswer(answer: ModelAnswer, ctx: VerifyContext): VerifiedAnswer {
  const lang = ctx.lang
  const env: Env = {
    read: readIndex(ctx.read, ctx.lang),
    ctx,
    thresholds: tightenFreshness(ctx.thresholds),
  }
  const mentionsName = nameMatcher(ctx.knownNames, ctx.capitalNames ?? [], lang)
  const list: AnswerAnomaly[] = []
  let total = 1
  if (answer.lang !== lang) list.push({ code: 'lang_mismatch', index: 0 })

  const hasData = (text: string) => dataKindsIn(text, lang).length > 0

  const segments = answer.segments.map((seg, index): VerifiedSegment => {
    total += CHECKS_PER_SEGMENT
    const text = canonicalText(seg.text)
    const dataKinds = dataKindsIn(text, lang)
    const mentionsKnownName = mentionsName(text)
    const mixedScript = hasMixedScript(text)
    const inScope =
      dataKinds.length > 0 || mentionsKnownName || mixedScript || seg.nature === 'fact'
    if (mixedScript) list.push({ code: 'mixed_script', index })
    const sources = requireNumbers(
      text,
      seg.sources.map((ref) => verifySource(ref, env)),
      lang,
    )
    const withoutSource = inScope && !sources.some((s) => s.verified)
    const { freshness, onlyFuture } = freshnessOfSources(sources)
    let suspendedReason: SuspendedReason | null = null
    if (withoutSource) suspendedReason = 'without_source'
    else if (inScope && freshness === 'stale') suspendedReason = 'stale_data'
    else if (inScope && onlyFuture) suspendedReason = 'unknown_freshness'
    // An unknown freshness is reported as `future_source_date`, below.
    if (suspendedReason === 'without_source' || suspendedReason === 'stale_data') {
      list.push({ code: suspendedReason, index })
    }
    if (sources.some((s) => s.verified && s.futureDate)) {
      list.push({ code: 'future_source_date', index })
    }
    if (sources.some((s) => s.verified && s.sourceDate === null)) {
      list.push({ code: 'unknown_source_freshness', index })
    }
    const contested = sources.some((s) => s.verified && s.contested)
    if (contested) list.push({ code: 'contested_source', index })
    return {
      text: suspendedReason ? null : text,
      originalText: text,
      nature: seg.nature,
      sources,
      inScope,
      dataKinds,
      mentionsKnownName,
      mixedScript,
      withoutSource,
      freshness,
      warning: warningOf(freshness, sources),
      contested,
      numbersSuspended: suspendedReason !== null,
      suspendedReason,
    }
  })

  const contradictions = answer.contradictions.map((c, index): VerifiedContradiction => {
    const sides = c.sides.map((s, side): VerifiedSide => {
      total += CHECKS_PER_SIDE
      const value = canonicalText(s.value)
      const [source] = requireNumbers(value, [verifySource(s.source, env)], lang) as [
        VerifiedSource,
      ]
      const { freshness, onlyFuture } = freshnessOfSources([source])
      const mixed = hasMixedScript(value)
      if (mixed) list.push({ code: 'contradiction_with_mixed_script', index, side })
      const carriesData = hasData(value) || mentionsName(value) || mixed
      let suspendedReason: SuspendedReason | null = null
      if (!source.verified) {
        suspendedReason = 'without_source'
        list.push({ code: 'contradiction_unverified_side', index, side })
      } else if (freshness === 'stale' && carriesData) {
        suspendedReason = 'stale_data'
        list.push({ code: 'contradiction_stale_side', index, side })
      } else if (onlyFuture && carriesData) {
        suspendedReason = 'unknown_freshness'
      }
      if (source.verified && source.futureDate) {
        list.push({ code: 'future_source_date', index, side })
      }
      if (source.verified && source.sourceDate === null) {
        list.push({ code: 'unknown_source_freshness', index, side })
      }
      return {
        value: suspendedReason ? null : value,
        originalValue: value,
        source,
        freshness,
        warning: warningOf(freshness, [source]),
        suspendedReason,
      }
    })
    total += CHECKS_PER_CONTRADICTION
    const sameDocument = new Set(c.sides.map((s) => identity(s.source))).size === 1
    if (sameDocument) list.push({ code: 'same_document_contradiction', index })
    const subject = canonicalText(c.subject)
    const reason = canonicalText(c.reason)
    const problem = textProblem([subject, reason], hasData, mentionsName)
    const suppressed = problem !== null
    if (problem) list.push({ code: CONTRADICTION_CODE[problem], index })
    return {
      subject: suppressed ? null : subject,
      reason: suppressed ? null : reason,
      originalSubject: subject,
      originalReason: reason,
      suppressed,
      sides,
      allSidesVerified: sides.every((s) => s.source.verified),
      sameDocument,
    }
  })

  const absences = answer.absences.map((a, index): VerifiedAbsence => {
    total += 1
    const question = canonicalText(a.question)
    const proposal = canonicalText(a.proposal)
    const problem = textProblem([question, proposal], hasData, mentionsName)
    const suppressed = problem !== null
    if (problem) list.push({ code: ABSENCE_CODE[problem], index })
    return {
      question: suppressed ? null : question,
      proposal: suppressed ? null : proposal,
      originalQuestion: question,
      originalProposal: proposal,
      suppressed,
    }
  })

  return {
    lang,
    segments,
    contradictions,
    absences,
    checks: { total, anomalies: list.length, list },
  }
}
