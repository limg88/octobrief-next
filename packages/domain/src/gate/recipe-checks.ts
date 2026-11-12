import { canonicalText } from '../canonical.ts'
import { type Lang, vocabulary } from '../language/index.ts'
import { dataKindsIn, numbersIn } from '../numbers.ts'
import { CHECK_CLASS, type RecipeCheck, type TargetRef, type ValueRef } from '../recipe/checks.ts'
import type { DocumentBlock, DocumentSection } from '../recipe/document-model.ts'
import type { Recipe } from '../recipe/format.ts'
import { canonicalHash } from '../recipe/hash.ts'
import { isCalendarDate } from '../rome-time.ts'
import type { InternalDocument } from './audience.ts'
import { type DeclaredValue, declaredCellId, declaredPeriod, parseCellId } from './common-gates.ts'
import { phraseForm } from './internal-lexicon.ts'
import { runPairCheck } from './pair-checks.ts'
import type { DetailObject, RedTeamAnomaly, RedTeamRef } from './red-team-model.ts'
import { refKeyOf } from './red-team-model.ts'
import { runSegmentCheck } from './segment-checks.ts'

// The checks of a recipe, from the closed catalog, run by the code on the values of the draft
// with the class of the catalog. Every check reads bounded lists (the rows of the draft, the
// values the recipe lists) with sets, so its cost is linear. Phrases a recipe forbids are found
// as substrings of the normalized text, never through an expression built from the recipe. A
// check whose values are «non dedotto» or not numbers cannot be judged: that is an anomaly of the
// check too, never a silent pass.

export interface RecipeChecksContext {
  recipe: Recipe
  lang: Lang
  /** The values of the parameters as titles show them, by id. */
  parameters: Readonly<Record<string, string>>
  /** The calendar days of the period parameters, by id. */
  periods: Readonly<Record<string, { from: string; to: string }>>
  declaredValues: readonly DeclaredValue[]
}

export interface RecipeChecksReport {
  checks: number
  anomalies: RedTeamAnomaly[]
}

type Outcome =
  | { ok: true }
  | { ok: false; evaluable: boolean; content: unknown; detail?: DetailObject }

const PASS: Outcome = { ok: true }
const notEvaluable = (content: unknown, detail: DetailObject = {}): Outcome => ({
  ok: false,
  evaluable: false,
  content,
  detail,
})
const failed = (content: unknown, detail: DetailObject = {}): Outcome => ({
  ok: false,
  evaluable: true,
  content,
  detail,
})

/** Canonical and lowercase: how the checks compare texts. */
const norm = (text: string) => canonicalText(text).toLowerCase()

const TOLERANCE = 1e-9

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
}

/**
 * The number a cell shows, in the notation of the language («12.000,50 €» is 12000.5, «−3» is
 * −3); `null` for «non dedotto», for no number or for more than one.
 */
export function cellNumber(text: string | null, lang: Lang): number | null {
  if (text === null) return null
  const t = canonicalText(text)
  const found = numbersIn(t, lang)
  if (found.length !== 1) return null
  const value = Number(found[0])
  if (!Number.isFinite(value)) return null
  const firstDigit = t.search(/\d/u)
  const negative = firstDigit > 0 && /[-−]\s*€?\s*$/u.test(t.slice(0, firstDigit))
  return negative ? -value : value
}

/**
 * The calendar day (`yyyy-mm-dd`) a cell shows: ISO, `gg/mm/aaaa` or with the name of the month
 * («1 ottobre 2026»); `null` otherwise.
 */
export function cellDay(text: string | null, lang: Lang): string | null {
  if (text === null) return null
  const t = norm(text)
  let y: number
  let m: number
  let d: number
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(t)
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/u.exec(t)
  const named = /^(\d{1,2}) ([\p{L}]+) (\d{4})$/u.exec(t)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (numeric) [d, m, y] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])]
  else if (named) {
    const months = vocabulary(lang).MONTHS
    const month = Object.hasOwn(months, named[2] as string) ? months[named[2] as string] : undefined
    if (month === undefined) return null
    ;[d, m, y] = [Number(named[1]), month, Number(named[3])]
  } else return null
  if (!isCalendarDate(y, m, d)) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

interface Located {
  section: DocumentSection
  block: DocumentBlock
}

class Draft {
  private readonly blocks = new Map<string, Located>()
  readonly doc: InternalDocument
  readonly ctx: RecipeChecksContext

  constructor(doc: InternalDocument, ctx: RecipeChecksContext) {
    this.doc = doc
    this.ctx = ctx
    for (const section of doc.sections) {
      for (const block of section.blocks) {
        if (!this.blocks.has(block.id)) this.blocks.set(block.id, { section, block })
      }
    }
  }

  block(id: string): Located | undefined {
    return this.blocks.get(id)
  }

  /**
   * The rows of a table or a list, with the cells of its columns by id. A block the PM excluded
   * rows from is judged with them: the exclusion changes what is shown, never what is checked.
   */
  rows(
    id: string,
  ): Array<{ key: string; cell: (column: string) => string | null | undefined }> | null {
    const shown = this.shownRows(id)
    if (shown === null) return null
    const exclusion = this.ctx.recipe.exclusions?.find((e) => e.block === id)
    const excluded = exclusion === undefined ? null : this.shownRows(exclusion.shownIn)
    return excluded === null ? shown : [...shown, ...excluded]
  }

  private shownRows(
    id: string,
  ): Array<{ key: string; cell: (column: string) => string | null | undefined }> | null {
    const at = this.blocks.get(id)
    if (at === undefined || (at.block.kind !== 'table' && at.block.kind !== 'list')) return null
    const b = at.block
    const index = new Map(b.columns.map((c, i) => [c.id, i]))
    const rows = b.kind === 'table' ? b.rows : b.items
    return rows.map((r) => ({
      key: r.key,
      cell: (column: string) => {
        const i = index.get(column)
        return i === undefined ? undefined : (r.cells[i]?.text ?? null)
      },
    }))
  }

  /** The texts of a column; `null` when the block or the column is not in the draft. */
  column(block: string, column: string): Array<string | null> | null {
    const rows = this.rows(block)
    if (rows === null) return null
    const out: Array<string | null> = []
    for (const r of rows) {
      const v = r.cell(column)
      if (v === undefined) return null
      out.push(v)
    }
    if (rows.length === 0) {
      const at = this.blocks.get(block)?.block
      if (
        at &&
        (at.kind === 'table' || at.kind === 'list') &&
        !at.columns.some((c) => c.id === column)
      ) {
        return null
      }
    }
    return out
  }

  /** The text of a value block or of a parameter; `undefined` when absent. */
  value(ref: ValueRef): string | null | undefined {
    if ('parameter' in ref) {
      return Object.hasOwn(this.ctx.parameters, ref.parameter)
        ? (this.ctx.parameters[ref.parameter] as string)
        : null
    }
    const at = this.blocks.get(ref.value)
    return at?.block.kind === 'value' ? at.block.cell.text : undefined
  }
}

const num = (draft: Draft, text: string | null | undefined) =>
  text === undefined ? null : cellNumber(text, draft.ctx.lang)

/** How deep a chain of computed values is followed back to the figures it is made of. */
const MAX_VALUE_DEPTH = 5

/**
 * Half a cent: how far an amount typed to the cent may be from the exact amount a percent gives
 * (15% of 333.333,33 is 49.999,9995, typed 50.000,00).
 */
const HALF_CENT = 0.005

/** The two figures of a ratio value, as the draft shows them; null for a value of another kind. */
function ratioOperands(
  draft: Draft,
  ref: ValueRef,
  depth: number,
): { left: number; right: number } | null {
  if (!('value' in ref) || depth >= MAX_VALUE_DEPTH) return null
  const block = draft.ctx.recipe.sections
    .flatMap((s) => s.blocks)
    .find((b) => b.id === ref.value && b.kind === 'data_value')
  if (block?.kind !== 'data_value' || block.compute.op !== 'ratio') return null
  const left = exactNumber(draft, block.compute.left, depth + 1)
  const right = exactNumber(draft, block.compute.right, depth + 1)
  return left === null || right === null || right === 0 ? null : { left, right }
}

/**
 * The figure a value stands for, as a number: a ratio is recomputed from its operands as the
 * draft shows them, not read from its percent rounded for the reader, so a contingency of
 * 10,04% is not taken for 10%, nor one of 7,25% for 7,3%. Every other value is the number its
 * text shows; null for none.
 */
function exactNumber(draft: Draft, ref: ValueRef, depth = 0): number | null {
  const shown = num(draft, draft.value(ref))
  if (shown === null) return null
  const ratio = ratioOperands(draft, ref, depth)
  return ratio === null ? shown : (ratio.left / ratio.right) * 100
}

/**
 * Whether two values are the same figure. A ratio and a percent are the same when the amount
 * the ratio divides is, within half a cent, the amount the percent gives of its base: an amount
 * typed to the cent is never an anomaly for its last decimal, and one off by more always is.
 */
function sameFigure(draft: Draft, left: ValueRef, right: ValueRef): boolean | null {
  const a = exactNumber(draft, left)
  const b = exactNumber(draft, right)
  if (a === null || b === null) return null
  if (sameNumber(a, b)) return true
  for (const [ratioRef, percent] of [
    [left, b],
    [right, a],
  ] as const) {
    const ratio = ratioOperands(draft, ratioRef, 0)
    if (ratio !== null && Math.abs(ratio.left - (percent * ratio.right) / 100) <= HALF_CENT) {
      return true
    }
  }
  return false
}

/**
 * The sum of the values of a column declared to the client before this run: each row (a request
 * number) once, with the value approved last, in any period; the rows this run shows are its own
 * and never counted twice. Null when a declared value is not a number.
 */
function declaredSum(draft: Draft, column: { block: string; column: string }): number | null {
  const recipe = draft.ctx.recipe
  const own = new Set((draft.rows(column.block) ?? []).map((r) => r.key))
  const latest = new Map<string, DeclaredValue>()
  for (const d of draft.ctx.declaredValues) {
    if (d.recipeSlug !== recipe.slug) continue
    const id = parseCellId(d.cellId)
    if (id?.[0] !== column.block || id[1] !== column.column) continue
    if (own.has(id[2] ?? '')) continue
    const known = latest.get(d.cellId)
    if (known === undefined || d.declaredAt > known.declaredAt) latest.set(d.cellId, d)
  }
  let sum = 0
  for (const d of latest.values()) {
    const n = num(draft, d.value)
    if (n === null) return null
    sum += n
  }
  return sum
}

function sumCheck(
  draft: Draft,
  column: { block: string; column: string },
  target: ValueRef,
  atMost: boolean,
  declared: number | null = 0,
): Outcome {
  const cells = draft.column(column.block, column.column)
  const targetText = draft.value(target)
  const content = { cells, target: targetText ?? null }
  if (cells === null) return notEvaluable(content)
  const values = cells.map((c) => num(draft, c))
  const total = num(draft, targetText)
  if (total === null || declared === null || values.some((v) => v === null)) {
    return notEvaluable(content)
  }
  const sum = (values as number[]).reduce((a, b) => a + b, declared)
  const ok = atMost ? sum < total || sameNumber(sum, total) : sameNumber(sum, total)
  return ok ? PASS : failed(content)
}

function setOf(values: ReadonlyArray<string | null>): Set<string> {
  const out = new Set<string>()
  for (const v of values) if (v !== null) out.add(norm(v))
  return out
}

/** The declared values of a column of the recipe, by row key, in the latest other period. */
function previousDeclared(
  draft: Draft,
  target: TargetRef,
): { values: Map<string, string | null>; single: boolean } | null {
  const recipe = draft.ctx.recipe
  const section = recipe.sections.find((s) => s.blocks.some((b) => b.id === target.block))
  if (section === undefined) return null
  const period = declaredPeriod(recipe, draft.ctx.periods)
  const matching = draft.ctx.declaredValues.filter((d) => {
    if (d.recipeSlug !== recipe.slug || d.sectionId !== section.id || d.period === period)
      return false
    if (target.column === undefined) return d.cellId === declaredCellId(target.block)
    const parsed = parseCellId(d.cellId)
    return parsed !== null && parsed[0] === target.block && parsed[1] === target.column
  })
  if (matching.length === 0) return null
  const latest = matching.reduce((a, b) => (b.declaredAt > a.declaredAt ? b : a))
  const values = new Map<string, string | null>()
  for (const d of matching) {
    if (d.period !== latest.period) continue
    const parsed = parseCellId(d.cellId)
    values.set(target.column === undefined ? '' : (parsed?.[2] ?? ''), d.value)
  }
  return { values, single: target.column === undefined }
}

function sameValue(draft: Draft, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  const x = num(draft, a)
  const y = num(draft, b)
  if (x !== null && y !== null) return sameNumber(x, y)
  return norm(a) === norm(b)
}

function run(check: RecipeCheck, draft: Draft): Outcome {
  const lang = draft.ctx.lang
  switch (check.kind) {
    case 'sum_equals':
      return sumCheck(draft, check.column, check.equals, false)
    case 'sum_at_most':
      return sumCheck(
        draft,
        check.column,
        check.atMost,
        true,
        check.withDeclared === true ? declaredSum(draft, check.column) : 0,
      )
    case 'difference_equals': {
      const rows = draft.rows(check.block)
      if (rows === null) return notEvaluable(null)
      let bad = 0
      const content: unknown[] = []
      for (const r of rows) {
        const [result, minuend, subtrahend] = [check.result, check.minuend, check.subtrahend].map(
          (c) => num(draft, r.cell(c)),
        )
        content.push([r.key, r.cell(check.result), r.cell(check.minuend), r.cell(check.subtrahend)])
        if (result == null || minuend == null || subtrahend == null) return notEvaluable(content)
        if (!sameNumber(result, minuend - subtrahend)) bad++
      }
      return bad === 0 ? PASS : failed(content, { rows: bad })
    }
    case 'values_equal': {
      const left = draft.value(check.left)
      const right = draft.value(check.right)
      const content = { left: left ?? null, right: right ?? null }
      if (left == null || right == null) return notEvaluable(content)
      // Two figures are compared unrounded: a percent as computed, not as shown.
      const figures = sameFigure(draft, check.left, check.right)
      if (figures !== null) return figures ? PASS : failed(content)
      return sameValue(draft, left, right) ? PASS : failed(content)
    }
    case 'present': {
      const at = draft.block(check.block)
      if (at === undefined) return failed({ block: null })
      const b = at.block
      const present =
        b.kind === 'value'
          ? b.cell.text !== null
          : b.kind === 'text'
            ? b.segments.length > 0
            : b.kind === 'static'
              ? true
              : !b.notDeduced && (b.kind === 'table' ? b.rows : b.items).length > 0
      return present ? PASS : failed({ block: b })
    }
    case 'member_of': {
      const values = draft.column(check.column.block, check.column.column)
      const pool = draft.column(check.in.block, check.in.column)
      const content = { values, pool }
      if (values === null || pool === null) return notEvaluable(content)
      const allowed = setOf(pool)
      const bad = values.filter((v) => v !== null && !allowed.has(norm(v))).length
      return bad === 0 ? PASS : failed(content, { rows: bad })
    }
    case 'count_consistent': {
      const rows = draft.rows(check.block)
      const count = draft.value(check.count)
      const content = { rows: rows?.length ?? null, count: count ?? null }
      const expected = num(draft, count)
      if (rows === null || expected === null) return notEvaluable(content)
      return sameNumber(rows.length, expected) ? PASS : failed(content)
    }
    case 'date_within_period': {
      const cells = draft.column(check.column.block, check.column.column)
      const period = Object.hasOwn(draft.ctx.periods, check.period)
        ? draft.ctx.periods[check.period]
        : undefined
      const content = { cells, period: period ?? null }
      if (cells === null || period === undefined) return notEvaluable(content)
      let bad = 0
      for (const c of cells) {
        if (c === null) continue
        const day = cellDay(c, lang)
        if (day === null) return notEvaluable(content)
        if (day < period.from || day > period.to) bad++
      }
      return bad === 0 ? PASS : failed(content, { rows: bad })
    }
    case 'unique': {
      const cells = draft.column(check.column.block, check.column.column)
      if (cells === null) return notEvaluable({ cells })
      const seen = new Set<string>()
      let duplicates = 0
      for (const c of cells) {
        if (c === null) continue
        const k = norm(c)
        if (seen.has(k)) duplicates++
        seen.add(k)
      }
      let declared = 0
      if (check.againstDeclared) {
        const recipe = draft.ctx.recipe
        const period = declaredPeriod(recipe, draft.ctx.periods)
        const before = new Set<string>()
        for (const d of draft.ctx.declaredValues) {
          if (d.recipeSlug !== recipe.slug || d.period === period || d.value === null) continue
          const id = parseCellId(d.cellId)
          if (id?.[0] === check.column.block && id[1] === check.column.column)
            before.add(norm(d.value))
        }
        for (const k of seen) if (before.has(k)) declared++
      }
      return duplicates === 0 && declared === 0
        ? PASS
        : failed({ cells }, { duplicates, alreadyDeclared: declared })
    }
    case 'coverage': {
      const universe = draft.column(check.universe.block, check.universe.column)
      const covers = check.coveredBy.map((c) => draft.column(c.block, c.column))
      const content = { universe, covers }
      if (universe === null || covers.some((c) => c === null)) return notEvaluable(content)
      const sets = (covers as Array<Array<string | null>>).map(setOf)
      let uncovered = 0
      let overlapping = 0
      for (const k of setOf(universe)) {
        const n = sets.reduce((count, s) => count + (s.has(k) ? 1 : 0), 0)
        if (n === 0 && !check.allowUnassigned) uncovered++
        if (n > 1 && check.exclusive) overlapping++
      }
      return uncovered === 0 && overlapping === 0
        ? PASS
        : failed(content, { uncovered, overlapping })
    }
    case 'implies': {
      const rows = draft.rows(check.block)
      if (rows === null) return notEvaluable(null)
      const when = new Set(check.condition.in.map(norm))
      const then = new Set(check.consequence.in.map(norm))
      let bad = 0
      const content: unknown[] = []
      for (const r of rows) {
        const cond = r.cell(check.condition.column)
        const cons = r.cell(check.consequence.column)
        if (cond === undefined || cons === undefined) return notEvaluable(null)
        content.push([r.key, cond, cons])
        if (cond !== null && when.has(norm(cond)) && (cons === null || !then.has(norm(cons)))) bad++
      }
      return bad === 0 ? PASS : failed(content, { rows: bad })
    }
    case 'equals_previous': {
      const previous = previousDeclared(draft, check.previous)
      // Nothing declared before (the first deliverable of the series): nothing to compare.
      if (previous === null) return PASS
      const target = check.current
      if (target.column === undefined) {
        const current = draft.value({ value: target.block })
        const before = previous.values.values().next().value ?? null
        const content = { current: current ?? null, previous: before }
        if (current === undefined) return notEvaluable(content)
        return sameValue(draft, current, before) ? PASS : failed(content)
      }
      const rows = draft.rows(target.block)
      if (rows === null) return notEvaluable(null)
      let bad = 0
      const content: unknown[] = []
      for (const r of rows) {
        if (!previous.values.has(r.key)) continue
        const now = r.cell(target.column)
        if (now === undefined) return notEvaluable(null)
        const before = previous.values.get(r.key) ?? null
        content.push([r.key, now, before])
        if (!sameValue(draft, now, before)) bad++
      }
      return bad === 0 ? PASS : failed(content, { rows: bad })
    }
    case 'bounded_text': {
      const at = draft.block(check.slot)
      if (at === undefined || at.block.kind !== 'text') return notEvaluable(null)
      const segments = at.block.segments
      const slot = draft.ctx.recipe.sections
        .flatMap((s) => s.blocks)
        .find((b) => b.id === check.slot && b.kind === 'text_slot')
      const max =
        check.maxChars ?? (slot?.kind === 'text_slot' ? slot.maxChars : Number.POSITIVE_INFINITY)
      const length = segments.reduce((n, s) => n + [...s.text].length, 0)
      const all = phraseForm(segments.map((s) => s.text).join(' '))
      const phrases = check.forbiddenPhrases.filter((p) => {
        const needle = phraseForm(p)
        return needle !== '' && all.includes(needle)
      }).length
      const connectors = check.connectorsWithoutData
        ? segments.filter((s) => s.sources.length === 0 && dataKindsIn(s.text, lang).length > 0)
            .length
        : 0
      const tooLong = length > max
      return !tooLong && phrases === 0 && connectors === 0
        ? PASS
        : failed(segments, { tooLong, phrases, connectors })
    }
    case 'agree_by_key':
    case 'all_equal_when':
    case 'sum_by_key':
      return runPairCheck(check, {
        rows: (id) => draft.rows(id),
        value: (ref) => draft.value(ref),
        number: (text) => num(draft, text),
        same: (a, b) => sameValue(draft, a, b),
        sameNumber,
        norm,
      })
    case 'segments_cited':
    case 'segment_fields':
      return runSegmentCheck(check, draft.doc, draft.ctx.recipe) ?? notEvaluable(null)
  }
}

/** The text slot a check is about, if any: only those can be rewritten automatically. */
function slotOf(check: RecipeCheck): string | null {
  return check.kind === 'bounded_text' ? check.slot : null
}

/** Runs the checks of the recipe on the draft, each with the class of the catalog. */
export function runRecipeChecks(
  doc: InternalDocument,
  ctx: RecipeChecksContext,
): RecipeChecksReport {
  const draft = new Draft(doc, ctx)
  const anomalies: RedTeamAnomaly[] = []
  for (const check of ctx.recipe.checks) {
    const outcome = run(check, draft)
    if (outcome.ok) continue
    const ref: RedTeamRef = { element: 'check', check: check.id }
    anomalies.push({
      code: outcome.evaluable ? 'recipe_check_failed' : 'recipe_check_not_evaluable',
      gate: null,
      class: CHECK_CLASS[check.kind],
      ref,
      refKey: refKeyOf(ref),
      contentHash: canonicalHash({ check: check.id, content: outcome.content }),
      place: {},
      slot: slotOf(check),
      resolution: 'acceptance',
      status: 'open',
      detail: { kind: check.kind, label: check.label, message: check.message, ...outcome.detail },
    })
  }
  return { checks: ctx.recipe.checks.length, anomalies }
}
