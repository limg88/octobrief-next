import type { Lang } from '../language/index.ts'
import type { DataCategory } from './categories.ts'
import type { RecipeCheck } from './checks.ts'
import {
  type Recipe,
  type RecipeBlock,
  type RecipePrerequisite,
  type RecipeSection,
  TITLE_PLACEHOLDER,
} from './format.ts'
import { canonicalJson } from './hash.ts'
import { recipeText } from './messages/index.ts'
import type { MessageParams } from './validate.ts'

export const RECIPE_CHANGE_CODES = [
  'title_changed',
  'purpose_changed',
  'audience_changed',
  'section_added',
  'section_removed',
  'section_moved',
  'section_renamed',
  'section_now_required',
  'section_now_optional',
  'section_version_changed',
  'section_now_removable',
  'section_no_longer_removable',
  'block_added',
  'block_removed',
  'block_changed',
  'block_moved',
  'block_reordered',
  'slot_instructions_changed',
  'column_added',
  'column_removed',
  'column_category_changed',
  'columns_reordered',
  'value_category_changed',
  'parameter_added',
  'parameter_removed',
  'parameter_now_required',
  'parameter_now_optional',
  'parameter_changed',
  'prerequisite_added',
  'prerequisite_removed',
  'prerequisite_now_required',
  'prerequisite_now_optional',
  'prerequisite_freshness_changed',
  'check_added',
  'check_removed',
  'check_scope_extended',
  'check_scope_changed',
  'check_changed',
  'rule_added',
  'rule_removed',
  'red_team_rule_added',
  'red_team_rule_removed',
  'extra_category_added',
  'extra_category_removed',
  'format_added',
  'format_removed',
  'template_changed',
  'render_mapping_changed',
  'examples_changed',
  'recipe_changed',
  'exclusion_added',
  'client_version_condition_changed',
] as const
export type RecipeChangeCode = (typeof RECIPE_CHANGE_CODES)[number]

/** One difference between two versions of a recipe, with its text for the PM. */
export interface RecipeChange {
  code: RecipeChangeCode
  params: MessageParams
  text: string
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

/** The recipe with the parameters of its titles written as the PM knows them: «Periodo». */
function withShownTitles(r: Recipe): Recipe {
  const labels = new Map(r.parameters.map((p) => [p.id, p.label]))
  const shown = (title: string) =>
    title.replace(TITLE_PLACEHOLDER, (_, id: string) => `«${labels.get(id) ?? '…'}»`)
  return {
    ...r,
    sections: r.sections.map((s) => ({
      ...s,
      title: shown(s.title),
      blocks: s.blocks.map((b) =>
        b.kind === 'text_slot' && b.title !== undefined ? { ...b, title: shown(b.title) } : b,
      ),
    })),
  }
}

/** What the PM calls a block: its title or label, else the title of its section. */
function blockName(b: RecipeBlock, s: RecipeSection): string {
  if (b.kind === 'data_value') return b.label
  if (b.kind === 'static') return s.title
  return b.title ?? s.title
}

interface Placed {
  block: RecipeBlock
  section: RecipeSection
}

function blocksOf(r: Recipe): Map<string, Placed> {
  const out = new Map<string, Placed>()
  for (const section of r.sections) {
    for (const block of section.blocks) out.set(block.id, { block, section })
  }
  return out
}

/** The PM name of what a check looks at: columns, values, slots, parameters. */
function targetsOf(c: RecipeCheck, r: Recipe): Map<string, string> {
  const blocks = blocksOf(r)
  const out = new Map<string, string>()
  const block = (id: string) => {
    const p = blocks.get(id)
    out.set(`block:${id}`, p ? blockName(p.block, p.section) : id)
  }
  const column = (blockId: string, columnId: string) => {
    const b = blocks.get(blockId)?.block
    const col =
      b && (b.kind === 'data_table' || b.kind === 'data_list')
        ? b.columns.find((x) => x.id === columnId)
        : undefined
    out.set(`column:${blockId}.${columnId}`, col?.title ?? columnId)
  }
  const parameter = (id: string) => {
    out.set(`parameter:${id}`, r.parameters.find((p) => p.id === id)?.label ?? id)
  }
  const value = (ref: { value: string } | { parameter: string }) =>
    'value' in ref ? block(ref.value) : parameter(ref.parameter)
  switch (c.kind) {
    case 'sum_equals':
      column(c.column.block, c.column.column)
      value(c.equals)
      break
    case 'sum_at_most':
      column(c.column.block, c.column.column)
      value(c.atMost)
      break
    case 'difference_equals':
      for (const id of [c.result, c.minuend, c.subtrahend]) column(c.block, id)
      break
    case 'values_equal':
      value(c.left)
      value(c.right)
      break
    case 'present':
      block(c.block)
      break
    case 'member_of':
      column(c.column.block, c.column.column)
      column(c.in.block, c.in.column)
      break
    case 'count_consistent':
      block(c.block)
      value(c.count)
      break
    case 'date_within_period':
      column(c.column.block, c.column.column)
      parameter(c.period)
      break
    case 'unique':
      column(c.column.block, c.column.column)
      break
    case 'coverage':
      for (const ref of [c.universe, ...c.coveredBy]) column(ref.block, ref.column)
      break
    case 'implies':
      column(c.block, c.condition.column)
      column(c.block, c.consequence.column)
      break
    case 'equals_previous':
      for (const t of [c.current, c.previous]) {
        if (t.column === undefined) block(t.block)
        else column(t.block, t.column)
      }
      break
    case 'bounded_text':
    case 'segments_cited':
    case 'segment_fields':
      block(c.slot)
      break
    case 'agree_by_key':
      for (const side of [c.left, c.right]) {
        column(side.block, side.key)
        column(side.block, side.value)
      }
      break
    case 'all_equal_when':
      value(c.when.value)
      column(c.column.block, c.column.column)
      break
    case 'sum_by_key':
      for (const side of [c.rows, c.totals]) {
        column(side.block, side.key)
        column(side.block, side.value)
      }
      break
  }
  return out
}

/** What identifies a prerequisite across two versions. */
export function prerequisiteKey(p: RecipePrerequisite): string {
  switch (p.kind) {
    case 'evidence':
      return `evidence:${[...p.documentKinds].sort().join(',')}`
    case 'source':
      return `source:${[...p.sourceKinds].sort().join(',')}`
    case 'fact':
      return `fact:${p.factKind}:${p.key ?? ''}`
  }
}

/** What the PM calls a prerequisite. */
export function prerequisiteName(p: RecipePrerequisite, lang: Lang): string {
  switch (p.kind) {
    case 'evidence':
      return p.documentKinds.map((k) => recipeText('documentKinds', k, {}, lang)).join(', ')
    case 'source':
      return p.sourceKinds.map((k) => recipeText('sourceKinds', k, {}, lang)).join(', ')
    case 'fact':
      return recipeText('factKinds', p.factKind, {}, lang)
  }
}

/** Items of two lists matched by a key: those only in `a`, only in `b`, and in both. */
function match<T>(a: readonly T[], b: readonly T[], key: (t: T) => string) {
  const ma = new Map(a.map((t) => [key(t), t]))
  const mb = new Map(b.map((t) => [key(t), t]))
  return {
    removed: a.filter((t) => !mb.has(key(t))),
    added: b.filter((t) => !ma.has(key(t))),
    both: a.flatMap((t) => {
      const other = mb.get(key(t))
      return other === undefined ? [] : [[t, other] as const]
    }),
  }
}

/**
 * The differences from version `a` to version `b` of a recipe, in the words of the PM («Aggiunta
 * la sezione “Rischi”», «Il controllo “somma delle posizioni” ora vale anche per …»), from the
 * dictionary of the core: never JSON, never an identifier.
 */
export function diffRecipes(before: Recipe, after: Recipe, lang: Lang): RecipeChange[] {
  const a = withShownTitles(before)
  const b = withShownTitles(after)
  const out: RecipeChange[] = []
  const add = (code: RecipeChangeCode, params: MessageParams = {}) => {
    out.push({ code, params, text: recipeText('changes', code, params, lang) })
  }

  if (a.title !== b.title) add('title_changed', { from: a.title, to: b.title })
  if (a.purpose !== b.purpose) add('purpose_changed')
  if (a.audience !== b.audience) add('audience_changed', { audience: b.audience })

  diffSections(a, b, add)
  diffBlocks(a, b, add)

  const params = match(a.parameters, b.parameters, (p) => p.id)
  for (const p of params.added) add('parameter_added', { name: p.label })
  for (const p of params.removed) add('parameter_removed', { name: p.label })
  for (const [pa, pb] of params.both) {
    if (pa.required !== pb.required) {
      add(pb.required ? 'parameter_now_required' : 'parameter_now_optional', { name: pb.label })
    }
    const rest = (p: typeof pa) => ({ ...p, required: undefined })
    if (!same(rest(pa), rest(pb))) add('parameter_changed', { name: pb.label })
  }

  const prereqs = match(a.prerequisites, b.prerequisites, prerequisiteKey)
  for (const p of prereqs.added) add('prerequisite_added', { name: prerequisiteName(p, lang) })
  for (const p of prereqs.removed) add('prerequisite_removed', { name: prerequisiteName(p, lang) })
  for (const [pa, pb] of prereqs.both) {
    const name = prerequisiteName(pb, lang)
    if (pa.level !== pb.level) {
      add(pb.level === 'required' ? 'prerequisite_now_required' : 'prerequisite_now_optional', {
        name,
      })
    }
    if (pa.kind === 'source' && pb.kind === 'source' && !same(pa.freshness, pb.freshness)) {
      const f = pb.freshness ?? { warnAfterHours: 24, stopAfterHours: 72 }
      add('prerequisite_freshness_changed', {
        name,
        warn: f.warnAfterHours,
        stop: f.stopAfterHours,
      })
    }
  }

  const checks = match(a.checks, b.checks, (c) => c.id)
  for (const c of checks.added) add('check_added', { name: c.label })
  for (const c of checks.removed) add('check_removed', { name: c.label })
  for (const [ca, cb] of checks.both) {
    const ta = targetsOf(ca, a)
    const tb = targetsOf(cb, b)
    const gained = [...tb.keys()].filter((k) => !ta.has(k))
    const kept = [...ta.keys()].every((k) => tb.has(k))
    if (gained.length > 0 && kept) {
      add('check_scope_extended', {
        name: cb.label,
        targets: gained.map((k) => `“${tb.get(k)}”`).join(', '),
      })
    } else if (!same([...ta.keys()].sort(), [...tb.keys()].sort())) {
      add('check_scope_changed', {
        name: cb.label,
        targets: [...tb.values()].map((t) => `“${t}”`).join(', '),
      })
    } else if (!same(ca, cb)) {
      add('check_changed', { name: cb.label })
    }
  }

  const textList = (
    xa: readonly string[],
    xb: readonly string[],
    added: RecipeChangeCode,
    removed: RecipeChangeCode,
  ) => {
    const m = match(xa, xb, (t) => t.normalize('NFC'))
    for (const t of m.added) add(added, { text: t })
    for (const t of m.removed) add(removed, { text: t })
  }
  textList(a.rules, b.rules, 'rule_added', 'rule_removed')
  textList(a.redTeamRules, b.redTeamRules, 'red_team_rule_added', 'red_team_rule_removed')

  const extraName = (r: Recipe, e: { block: string; column?: string | undefined }) => {
    const p = blocksOf(r).get(e.block)
    if (!p) return e.block
    const b = p.block
    if (e.column !== undefined && (b.kind === 'data_table' || b.kind === 'data_list')) {
      return b.columns.find((c) => c.id === e.column)?.title ?? e.column
    }
    return blockName(b, p.section)
  }
  const extras = match(
    a.extraInternalCategories,
    b.extraInternalCategories,
    (e) => `${e.block}.${e.column ?? ''}:${e.category}`,
  )
  for (const e of extras.added) {
    add('extra_category_added', { name: extraName(b, e), category: e.category })
  }
  for (const e of extras.removed) {
    add('extra_category_removed', { name: extraName(a, e), category: e.category })
  }

  const formats = match(a.render.formats, b.render.formats, (f) => f)
  for (const f of formats.added) add('format_added', { format: f })
  for (const f of formats.removed) add('format_removed', { format: f })
  if (a.render.template !== b.render.template) add('template_changed')
  if (
    !same(a.render.sections, b.render.sections) ||
    !same(a.render.namedCells, b.render.namedCells)
  ) {
    add('render_mapping_changed')
  }
  if (!same(a.examples, b.examples)) add('examples_changed')
  for (const e of b.exclusions ?? []) {
    const was = (a.exclusions ?? []).find((x) => x.block === e.block && x.field === e.field)
    const added = e.values.filter((v) => !(was?.values ?? []).includes(v))
    if (added.length === 0) continue
    const p = blocksOf(b).get(e.block)
    add('exclusion_added', {
      name: p ? blockName(p.block, p.section) : '',
      values: added.map((v) => `“${v}”`).join(', '),
    })
  }
  if (!same(a.clientVersionWhen, b.clientVersionWhen)) add('client_version_condition_changed')
  // Nothing named, yet not the same recipe: say so rather than nothing.
  if (out.length === 0 && !same({ ...before, version: '' }, { ...after, version: '' })) {
    add('recipe_changed')
  }
  return out
}

type Add = (code: RecipeChangeCode, params?: MessageParams) => void

function diffSections(a: Recipe, b: Recipe, add: Add): void {
  const sections = match(a.sections, b.sections, (s) => s.id)
  for (const s of sections.added) add('section_added', { section: s.title })
  for (const s of sections.removed) add('section_removed', { section: s.title })
  // Moved: only the sections that changed place relative to the others are named.
  const common = new Set(sections.both.map(([x]) => x.id))
  const order = (r: Recipe) => r.sections.filter((x) => common.has(x.id)).map((x) => x.id)
  const titles = new Map(b.sections.map((x) => [x.id, x.title]))
  for (const id of movedIds(order(a), order(b))) {
    add('section_moved', { section: titles.get(id) ?? '' })
  }
  for (const [sa, sb] of sections.both) {
    if (sa.title !== sb.title) add('section_renamed', { from: sa.title, to: sb.title })
    if (sa.required !== sb.required) {
      add(sb.required ? 'section_now_required' : 'section_now_optional', { section: sb.title })
    }
    if (sa.version !== sb.version) {
      add('section_version_changed', { section: sb.title, version: sb.version })
    }
    if (sa.removable !== sb.removable) {
      add(sb.removable ? 'section_now_removable' : 'section_no_longer_removable', {
        section: sb.title,
      })
    }
  }
}

/**
 * The ids to name as moved: those outside a longest common subsequence of the two orders, so
 * moving one element names that element, not every element it passed. In the order of `after`.
 */
function movedIds(before: readonly string[], after: readonly string[]): string[] {
  const n = before.length
  const m = after.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] =
        before[i] === after[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number)
    }
  }
  const stay = new Set<string>()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      stay.add(before[i] as string)
      i++
      j++
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      i++
    } else {
      j++
    }
  }
  return after.filter((id) => !stay.has(id))
}

function diffBlocks(a: Recipe, b: Recipe, add: Add): void {
  const ba = blocksOf(a)
  const bb = blocksOf(b)
  // The list of the rows the PM excluded is named by the exclusion itself.
  const lists = new Set((b.exclusions ?? []).map((e) => e.shownIn))
  for (const [id, p] of bb) {
    if (!ba.has(id) && !lists.has(id) && a.sections.some((s) => s.id === p.section.id)) {
      add('block_added', { section: p.section.title, name: blockName(p.block, p.section) })
    }
  }
  for (const [id, p] of ba) {
    if (!bb.has(id) && b.sections.some((s) => s.id === p.section.id)) {
      add('block_removed', { section: p.section.title, name: blockName(p.block, p.section) })
    }
  }
  // A block that changed section, then the blocks that changed place within their section.
  for (const [id, pa] of ba) {
    const pb = bb.get(id)
    if (pb !== undefined && pa.section.id !== pb.section.id) {
      add('block_moved', {
        name: blockName(pb.block, pb.section),
        from: pa.section.title,
        to: pb.section.title,
      })
    }
  }
  for (const sb of b.sections) {
    const sa = a.sections.find((x) => x.id === sb.id)
    if (sa === undefined) continue
    const stayed = (x: RecipeSection, other: Map<string, Placed>) =>
      x.blocks.filter((blk) => other.get(blk.id)?.section.id === x.id).map((blk) => blk.id)
    for (const id of movedIds(stayed(sa, bb), stayed(sb, ba))) {
      const placed = bb.get(id)
      if (placed) {
        add('block_reordered', { section: sb.title, name: blockName(placed.block, placed.section) })
      }
    }
  }
  for (const [id, pa] of ba) {
    const pb = bb.get(id)
    if (pb === undefined) continue
    const xa = pa.block
    const xb = pb.block
    const name = blockName(xb, pb.section)
    if (xa.kind !== xb.kind) {
      add('block_changed', { section: pb.section.title, name })
      continue
    }
    if (xa.kind === 'text_slot' && xb.kind === 'text_slot') {
      if (xa.instructions !== xb.instructions) {
        add('slot_instructions_changed', { section: pb.section.title, name })
      }
      if (!same({ ...xa, instructions: '' }, { ...xb, instructions: '' })) {
        add('block_changed', { section: pb.section.title, name })
      }
      continue
    }
    if (xa.kind === 'data_value' && xb.kind === 'data_value') {
      if (xa.category !== xb.category) {
        add('value_category_changed', { name, category: xb.category as DataCategory })
      }
      if (!same({ ...xa, category: '' }, { ...xb, category: '' })) {
        add('block_changed', { section: pb.section.title, name })
      }
      continue
    }
    if (
      (xa.kind === 'data_table' || xa.kind === 'data_list') &&
      (xb.kind === 'data_table' || xb.kind === 'data_list')
    ) {
      const cols = match(xa.columns, xb.columns, (c) => c.id)
      for (const c of cols.added) add('column_added', { name: c.title, block: name })
      for (const c of cols.removed) add('column_removed', { name: c.title, block: name })
      for (const [ca, cb] of cols.both) {
        if (ca.category !== cb.category) {
          add('column_category_changed', { name: cb.title, category: cb.category })
        }
      }
      const kept = new Set(cols.both.map(([c]) => c.id))
      const order = (x: typeof xa) => x.columns.filter((c) => kept.has(c.id)).map((c) => c.id)
      if (!same(order(xa), order(xb))) add('columns_reordered', { block: name })
      const shape = (x: typeof xa) => ({
        ...x,
        columns: x.columns
          .filter((c) => kept.has(c.id))
          .map((c) => ({ ...c, category: '' }))
          .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)),
      })
      if (!same(shape(xa), shape(xb))) add('block_changed', { section: pb.section.title, name })
      continue
    }
    if (!same(xa, xb)) add('block_changed', { section: pb.section.title, name })
  }
}
