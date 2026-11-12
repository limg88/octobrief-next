import type { DocumentKind } from '../classification.ts'
import { type FreshnessThresholds, freshnessOf, tightenFreshness } from '../freshness.ts'
import { freshnessPolicyOf } from '../freshness-policy.ts'
import { type FactKind, keyOf, normalizeKey } from '../knowledge.ts'
import type { Lang } from '../language/index.ts'
import { romeDateString } from '../rome-time.ts'
import { trackerDataAsOf } from '../tracker.ts'
import type { PrerequisiteLevel, Recipe, RecipePrerequisite } from './format.ts'
import { formatDay } from './gathered.ts'
import { recipeDictionary, recipeText } from './messages/index.ts'
import type { SourceKind } from './source-kinds.ts'

// Whether a recipe can run in a project now: deterministic, from what the project holds, without
// the model and without any job, so a page can show it when it opens. Three states, each with a
// reason in the PM's words: ready; a step the PM must take (upload a document, connect a source,
// state a fact); system data missing or too old to be used.

/** A source of the project as the prerequisites read it: its kind and the health of its sync. */
export interface PrerequisiteSource {
  kind: SourceKind
  label: string
  /** The last completed sync; null when none has completed. */
  lastSuccessAt: Date | null
  /** Up to when the source read its system; null when it does not say. */
  dataAsOf: Date | null
  /** The last run stopped with more to read. */
  pending: boolean
}

/** What a project holds, as the prerequisites of a recipe read it. */
export interface PrerequisiteView {
  /** The project thresholds (never looser than the defaults). */
  thresholds: FreshnessThresholds
  /** The kinds of the classified evidence still at its source (removed evidence excluded). */
  evidenceKinds: readonly DocumentKind[]
  sources: readonly PrerequisiteSource[]
  /** The facts that hold (active or contested). */
  facts: ReadonlyArray<{ kind: FactKind; key: string }>
}

export const PREREQUISITE_STATUSES = ['ready', 'needs_step', 'missing_system_data'] as const
export type PrerequisiteStatus = (typeof PREREQUISITE_STATUSES)[number]

/** One prerequisite as the PM reads it: what it asks, whether the project has it, and why not. */
export interface PrerequisiteCheck {
  /** `required` blocks the preparation; `if_present` («utile») only improves it. */
  level: PrerequisiteLevel
  /** What it asks: «un documento fra questi: contratti». */
  label: string
  present: boolean
  /** Why it is not met, in the PM's words; null when it is present. */
  reason: string | null
}

export interface PrerequisiteReport {
  status: PrerequisiteStatus
  /** What the PM reads: «Pronta», «Serve un passo: …», «Mancano dati di sistema aggiornati: …». */
  text: string
  /** The reasons, one per prerequisite not met, at most five. */
  reasons: string[]
  /** Every prerequisite of the recipe, required and useful, with its state. */
  checks: PrerequisiteCheck[]
}

const MAX_REASONS = 5

/**
 * Whether the stored key of a fact of `kind` is the key asked, or one of its subjects (asked
 * `fornitore`, the fact `risk:fornitore:ritardo` holds), the way keys are stored.
 */
export function factKeyMatches(kind: FactKind, asked: string, key: string): boolean {
  const a = keyOf(kind, asked)
  const k = normalizeKey(key)
  return k === a || k.startsWith(`${a}:`)
}

/** The age a source's data has, for a system: the data warehouse dates its data or not at all. */
function sourceDataAsOf(s: PrerequisiteSource): Date | null {
  if (s.lastSuccessAt === null) return null
  if (s.kind === 'netsuite_dwsi') return s.dataAsOf
  return trackerDataAsOf(s)
}

/** The thresholds of a prerequisite: the project's, made stricter by the recipe. */
function thresholdsOf(base: FreshnessThresholds, p: RecipePrerequisite): FreshnessThresholds {
  const t = tightenFreshness(base)
  if (p.kind !== 'source' || p.freshness === undefined) return t
  return {
    warnAfterHours: Math.min(t.warnAfterHours, p.freshness.warnAfterHours),
    stopAfterHours: Math.min(t.stopAfterHours, p.freshness.stopAfterHours),
  }
}

const list = (names: readonly string[]) => names.join(', ')

/**
 * Why the data of each source of a kind cannot be used: every source the recipe reads must be
 * synced, dated and within the stop threshold, or its data would be missing from the deliverable.
 */
function dataProblems(
  sources: readonly PrerequisiteSource[],
  t: FreshnessThresholds,
  now: Date,
  lang: Lang,
): string[] {
  const out: string[] = []
  for (const source of sources) {
    const name = source.label
    if (source.lastSuccessAt === null) {
      out.push(recipeText('gathering', 'data_never_synced', { source: name }, lang))
      continue
    }
    const at = sourceDataAsOf(source)
    if (at === null) {
      out.push(recipeText('gathering', 'data_undated', { source: name }, lang))
    } else if (freshnessOf(at, now, t).level === 'stale') {
      out.push(
        recipeText(
          'gathering',
          'data_stale',
          { source: name, date: formatDay(romeDateString(at)) },
          lang,
        ),
      )
    }
  }
  return out
}

/**
 * The state of the prerequisites of a recipe in a project at `now`. Only the required ones
 * count: a document of the kinds asked, a source of the kinds asked (and, for system data, data
 * not older than the stop threshold, the recipe's when stricter), a fact of the kind and key
 * asked. A step to take comes before data that is missing: the PM can act on it first.
 */
export function checkPrerequisites(
  recipe: Recipe,
  view: PrerequisiteView,
  now: Date,
  lang: Lang,
): PrerequisiteReport {
  const dict = recipeDictionary(lang)
  const steps: string[] = []
  const data: string[] = []
  const checks: PrerequisiteCheck[] = []
  for (const p of recipe.prerequisites) {
    const required = p.level === 'required'
    const check = (label: string, problems: readonly string[]) =>
      checks.push({
        level: p.level,
        label,
        present: problems.length === 0,
        reason:
          problems.length === 0
            ? null
            : problems.join(recipeText('gathering', 'list_separator', {}, lang)),
      })
    switch (p.kind) {
      case 'evidence': {
        const kinds = list(p.documentKinds.map((k) => dict.documentKinds[k]))
        const label = recipeText('gathering', 'need_evidence', { kinds }, lang)
        if (!view.evidenceKinds.some((k) => p.documentKinds.includes(k))) {
          const step = recipeText('gathering', 'step_evidence', { kinds }, lang)
          check(label, [step])
          if (required) steps.push(step)
        } else check(label, [])
        break
      }
      case 'source': {
        const kinds = list(p.sourceKinds.map((k) => dict.sourceKinds[k]))
        const label = recipeText('gathering', 'need_source', { kinds }, lang)
        const present = view.sources.filter((s) => p.sourceKinds.includes(s.kind))
        if (present.length === 0) {
          const step = recipeText('gathering', 'step_source', { kinds }, lang)
          check(label, [step])
          if (required) steps.push(step)
          break
        }
        const system = present.filter((s) => freshnessPolicyOf(s.kind, null) === 'system')
        const problems = dataProblems(system, thresholdsOf(view.thresholds, p), now, lang)
        check(label, problems)
        if (required) data.push(...problems)
        break
      }
      case 'fact': {
        const label =
          p.key === undefined
            ? recipeText('gathering', 'need_fact', { kind: p.factKind }, lang)
            : recipeText('gathering', 'need_fact_key', { key: p.key }, lang)
        const held = view.facts.some(
          (f) =>
            f.kind === p.factKind &&
            (p.key === undefined || factKeyMatches(p.factKind, p.key, f.key)),
        )
        if (!held) {
          const step =
            p.key === undefined
              ? recipeText('gathering', 'step_fact', { kind: p.factKind }, lang)
              : recipeText('gathering', 'step_fact_key', { key: p.key }, lang)
          check(label, [step])
          if (required) steps.push(step)
        } else check(label, [])
        break
      }
    }
  }
  const separator = recipeText('gathering', 'list_separator', {}, lang)
  if (steps.length > 0) {
    const reasons = steps.slice(0, MAX_REASONS)
    return {
      status: 'needs_step',
      text: recipeText('gathering', 'needs_step', { steps: reasons.join(separator) }, lang),
      reasons,
      checks,
    }
  }
  if (data.length > 0) {
    const reasons = [...new Set(data)].slice(0, MAX_REASONS)
    return {
      status: 'missing_system_data',
      text: recipeText(
        'gathering',
        'missing_system_data',
        { sources: reasons.join(separator) },
        lang,
      ),
      reasons,
      checks,
    }
  }
  return {
    status: 'ready',
    text: recipeText('gathering', 'ready', {}, lang),
    reasons: [],
    checks,
  }
}
