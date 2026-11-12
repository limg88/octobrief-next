import { z } from 'zod'
import { withoutInvisible } from '../canonical.ts'
import { DEFAULT_FRESHNESS } from '../freshness.ts'
import { hasForeignLetters, phraseForm } from '../gate/internal-lexicon.ts'
import type { Lang } from '../language/index.ts'
import { detectSuspicious } from '../suspicious.ts'
import {
  type DataCategory,
  isMoreRestrictive,
  MOST_RESTRICTIVE_CATEGORY,
  mostRestrictiveOf,
} from './categories.ts'
import {
  type CHECK_CLASSES,
  type CheckClass,
  checkClassOf,
  checkSchema,
  MAX_LABEL_LENGTH,
  MAX_SLOT_CHARS,
  MAX_TEXT_LENGTH,
  type RecipeCheck,
  recipeId,
} from './checks.ts'
import { diffRecipes, prerequisiteKey, prerequisiteName, type RecipeChange } from './diff.ts'
import { excludedListTitle } from './exclusions.ts'
import {
  MAX_EXCLUDED_VALUES,
  PREREQUISITE_LEVELS,
  type Recipe,
  type RecipeBlock,
  type RecipePrerequisite,
  type RecipeQuery,
  type RecipeSection,
  SECTION_VERSIONS,
  sectionSchema,
} from './format.ts'
import { formatDay, periodText } from './gathered.ts'
import { canonicalJson } from './hash.ts'
import { recipeText } from './messages/index.ts'
import { validateProjectRecipeSettings } from './project-settings.ts'
import {
  effectiveCategory,
  type MessageParams,
  type RecipeErrorCode,
  recipeErrorText,
  validateRecipe,
} from './validate.ts'

// A change of a recipe asked in words. The model never writes a recipe: it proposes a patch, a
// list of typed operations, and the code applies it, validates the result (`validateRecipe`) and
// compares it with the version in use. A change may only tighten: whatever makes the recipe less
// strict than the current version is refused, with the reason in the words of the PM, and no
// version is made of it.

export const MAX_PATCH_OPERATIONS = 20

const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH)
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH)
const hours = z.int().min(1).max(10_000)
const isoDay = z.iso.date()

/** One typed operation on a recipe. Some loosen it: they exist so the refusal can say why. */
export const patchOperationSchema = z.discriminatedUnion('op', [
  /** A new section, after the section `after` (at the end when null). */
  z.strictObject({
    op: z.literal('add_section'),
    section: sectionSchema,
    after: recipeId.nullable(),
  }),
  z.strictObject({ op: z.literal('remove_section'), section: recipeId }),
  z.strictObject({
    op: z.literal('set_section_required'),
    section: recipeId,
    required: z.boolean(),
  }),
  z.strictObject({
    op: z.literal('set_section_version'),
    section: recipeId,
    version: z.enum(SECTION_VERSIONS),
  }),
  /** A rule for the writer. */
  z.strictObject({ op: z.literal('add_rule'), text }),
  /** A control of the reviewer. */
  z.strictObject({ op: z.literal('add_red_team_rule'), text }),
  z.strictObject({ op: z.literal('remove_rule'), text }),
  z.strictObject({ op: z.literal('remove_red_team_rule'), text }),
  z.strictObject({
    op: z.literal('replace_rule'),
    list: z.enum(['rules', 'red_team_rules']),
    from: text,
    to: text,
  }),
  /** Rows of a block left out by the value of a field its columns show. */
  z.strictObject({
    op: z.literal('add_exclusion'),
    block: recipeId,
    field: z.string().min(1).max(100),
    values: z.array(label).min(1).max(MAX_EXCLUDED_VALUES),
  }),
  z.strictObject({ op: z.literal('add_check'), check: checkSchema }),
  z.strictObject({ op: z.literal('remove_check'), check: recipeId }),
  z.strictObject({
    op: z.literal('set_check_max_chars'),
    check: recipeId,
    maxChars: z.int().min(1).max(MAX_SLOT_CHARS),
  }),
  z.strictObject({
    op: z.literal('set_slot_max_chars'),
    slot: recipeId,
    maxChars: z.int().min(1).max(MAX_SLOT_CHARS),
  }),
  /** The freshness thresholds of a prerequisite, by its position in the list. */
  z.strictObject({
    op: z.literal('set_freshness'),
    prerequisite: z.int().min(0).max(100),
    warnAfterHours: hours,
    stopAfterHours: hours,
  }),
  z.strictObject({
    op: z.literal('set_prerequisite_level'),
    prerequisite: z.int().min(0).max(100),
    level: z.enum(PREREQUISITE_LEVELS),
  }),
  z.strictObject({
    op: z.literal('remove_extra_category'),
    block: recipeId,
    column: recipeId.nullable(),
  }),
  /** A default value of a parameter in the project: a setting, not a part of the recipe. */
  z.strictObject({
    op: z.literal('set_parameter_default'),
    parameter: recipeId,
    value: z.union([
      z.string().trim().min(1).max(MAX_TEXT_LENGTH),
      z.number(),
      z.strictObject({ from: isoDay, to: isoDay }),
    ]),
  }),
])
export type PatchOperation = z.infer<typeof patchOperationSchema>

export const recipePatchSchema = z.strictObject({
  operations: z.array(patchOperationSchema).min(1).max(MAX_PATCH_OPERATIONS),
})
export type RecipePatch = z.infer<typeof recipePatchSchema>

export const PATCH_REFUSAL_CODES = [
  'patch_malformed',
  'target_unknown',
  'nothing_to_change',
  'default_only_in_project',
  'default_invalid',
  'exclusion_conflict',
  'parameters_changed',
  'recipe_changed',
  'section_removed',
  'section_made_optional',
  'section_made_removable',
  'section_to_client',
  'section_changed',
  'prerequisite_removed',
  'prerequisite_made_optional',
  'threshold_loosened',
  'rule_removed',
  'red_team_rule_removed',
  'check_removed',
  'check_class_lowered',
  'check_weakened',
  'category_removed',
  'exclusion_removed',
  'label_bypassed',
  'labelled_section_replaced',
  'block_id_reused',
  'client_version_condition_changed',
  'client_version_by_default',
  'rule_loosening',
  'request_invalid',
] as const
export type PatchRefusalCode = (typeof PATCH_REFUSAL_CODES)[number]

/** Every text of the patch group: the refusals, the title of the excluded rows, a few names. */
export type PatchTextKey =
  | PatchRefusalCode
  | 'excluded_title'
  | 'default_set'
  | 'threshold_freshness'
  | 'threshold_length'

/** Why a patch is refused, with its text for the PM: never JSON, never an identifier. */
export interface PatchRefusal {
  code: PatchRefusalCode | RecipeErrorCode
  params: MessageParams
  text: string
}

export type PatchResult =
  | {
      ok: true
      patch: RecipePatch
      /** The new version; the current one, unchanged, when only defaults change. */
      recipe: Recipe
      /** The differences, in words (`diffRecipes`). */
      changes: RecipeChange[]
      /** Default values of parameters to save in the project. */
      parameterDefaults: Record<string, unknown>
      /** What changed, in words: the summary of the new version. */
      summary: string
    }
  | { ok: false; refusals: PatchRefusal[] }

export interface PatchOptions {
  /** `library`: the Admin's recipe, which has no project to keep defaults in. */
  scope?: 'project' | 'library'
}

const CLASS_RANK: Readonly<Record<CheckClass, number>> = Object.freeze({
  form: 0,
  structure: 1,
  data: 2,
} satisfies Record<(typeof CHECK_CLASSES)[number], number>)

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const nfc = (t: string) => t.normalize('NFC')

/** The next minor version: a change asked in words adds, it never breaks. */
function nextVersion(version: string): string {
  const [major, minor] = version.split('.').map(Number)
  return `${major ?? 0}.${(minor ?? 0) + 1}.0`
}

/** An identifier not yet used, from `base`, within the length of an identifier. */
function freeId(base: string, taken: ReadonlySet<string>): string {
  const id = base.slice(0, 40)
  if (!taken.has(id)) return id
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 40 - String(n).length - 1)}_${n}`
    if (!taken.has(candidate)) return candidate
  }
}

class Refusals {
  readonly list: PatchRefusal[] = []
  private readonly lang: Lang

  constructor(lang: Lang) {
    this.lang = lang
  }

  add(code: PatchRefusalCode, params: MessageParams = {}): void {
    this.list.push({ code, params, text: recipeText('patch', code, params, this.lang) })
  }
}

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>

function blockIndex(r: Recipe): Map<string, { block: RecipeBlock; section: RecipeSection }> {
  const out = new Map<string, { block: RecipeBlock; section: RecipeSection }>()
  for (const section of r.sections) {
    for (const block of section.blocks) out.set(block.id, { block, section })
  }
  return out
}

/** Applies the operations to the draft; an operation on what is not there is refused. */
function applyOperations(
  r: Recipe,
  ops: readonly PatchOperation[],
  defaults: Record<string, unknown>,
  refuse: Refusals,
  lang: Lang,
): void {
  const section = (id: string) => r.sections.find((s) => s.id === id)
  const unknown = () => refuse.add('target_unknown')
  for (const op of ops) {
    switch (op.op) {
      case 'add_section': {
        const at =
          op.after === null ? r.sections.length : r.sections.findIndex((s) => s.id === op.after) + 1
        if (at === 0) {
          unknown()
          break
        }
        r.sections.splice(at, 0, structuredClone(op.section))
        break
      }
      case 'remove_section': {
        const s = section(op.section)
        if (!s) {
          unknown()
          break
        }
        const blocks = new Set(s.blocks.map((b) => b.id))
        r.sections = r.sections.filter((x) => x !== s)
        r.render.sections = r.render.sections.filter((x) => x.section !== s.id)
        r.render.namedCells = r.render.namedCells.filter((c) => !blocks.has(c.block))
        r.extraInternalCategories = r.extraInternalCategories.filter((e) => !blocks.has(e.block))
        if (r.exclusions) r.exclusions = r.exclusions.filter((e) => !blocks.has(e.block))
        break
      }
      case 'set_section_required': {
        const s = section(op.section)
        if (!s) {
          unknown()
          break
        }
        s.required = op.required
        // A mandatory section cannot be removed from the project.
        if (op.required) s.removable = false
        break
      }
      case 'set_section_version': {
        const s = section(op.section)
        if (s) s.version = op.version
        else unknown()
        break
      }
      case 'add_rule':
        r.rules.push(op.text)
        break
      case 'add_red_team_rule':
        r.redTeamRules.push(op.text)
        break
      case 'remove_rule':
      case 'remove_red_team_rule': {
        const list = op.op === 'remove_rule' ? r.rules : r.redTeamRules
        const i = list.findIndex((t) => nfc(t) === nfc(op.text))
        if (i < 0) unknown()
        else list.splice(i, 1)
        break
      }
      case 'replace_rule': {
        const list = op.list === 'rules' ? r.rules : r.redTeamRules
        const i = list.findIndex((t) => nfc(t) === nfc(op.from))
        if (i < 0) unknown()
        else list[i] = op.to
        break
      }
      case 'add_exclusion':
        addExclusion(r, op, refuse, lang)
        break
      case 'add_check':
        r.checks.push(structuredClone(op.check))
        break
      case 'remove_check': {
        const before = r.checks.length
        r.checks = r.checks.filter((c) => c.id !== op.check)
        if (r.checks.length === before) unknown()
        break
      }
      case 'set_check_max_chars': {
        const c = r.checks.find((x) => x.id === op.check)
        if (c?.kind === 'bounded_text') c.maxChars = op.maxChars
        else unknown()
        break
      }
      case 'set_slot_max_chars': {
        const b = blockIndex(r).get(op.slot)?.block
        if (b?.kind === 'text_slot') b.maxChars = op.maxChars
        else unknown()
        break
      }
      case 'set_freshness': {
        const p = r.prerequisites[op.prerequisite]
        if (p?.kind === 'source') {
          p.freshness = { warnAfterHours: op.warnAfterHours, stopAfterHours: op.stopAfterHours }
        } else unknown()
        break
      }
      case 'set_prerequisite_level': {
        const p = r.prerequisites[op.prerequisite]
        if (p) p.level = op.level
        else unknown()
        break
      }
      case 'remove_extra_category': {
        const before = r.extraInternalCategories.length
        r.extraInternalCategories = r.extraInternalCategories.filter(
          (e) => !(e.block === op.block && (e.column ?? null) === op.column),
        )
        if (r.extraInternalCategories.length === before) unknown()
        break
      }
      case 'set_parameter_default':
        defaults[op.parameter] = op.value
        break
    }
  }
}

/**
 * Adds the values to the exclusion of the block, or makes it: the exclusion and, right after the
 * block, the list that shows the excluded rows with the same query, columns and key.
 */
function addExclusion(
  r: Recipe,
  op: Extract<PatchOperation, { op: 'add_exclusion' }>,
  refuse: Refusals,
  lang: Lang,
): void {
  const placed = blockIndex(r).get(op.block)
  const block = placed?.block
  if (placed === undefined || (block?.kind !== 'data_table' && block?.kind !== 'data_list')) {
    refuse.add('target_unknown')
    return
  }
  const values = [...new Set(op.values.map((v) => v.trim()))]
  const existing = r.exclusions?.find((e) => e.block === op.block)
  if (existing) {
    if (existing.field !== op.field) {
      refuse.add('exclusion_conflict', { name: block.title ?? placed.section.title })
      return
    }
    existing.values = [...new Set([...existing.values, ...values])]
    return
  }
  const rows = block as RowsBlock
  const shownIn = freeId(`${rows.id}_excluded`, new Set(blockIndex(r).keys()))
  const list: RowsBlock = {
    kind: 'data_list',
    id: shownIn,
    title: excludedListTitle(lang),
    query: structuredClone(rows.query),
    columns: structuredClone(rows.columns),
    ...(rows.key === undefined ? {} : { key: [...rows.key] }),
  }
  const blocks = placed.section.blocks
  blocks.splice(blocks.indexOf(rows) + 1, 0, list)
  r.exclusions = [...(r.exclusions ?? []), { block: rows.id, field: op.field, values, shownIn }]
  // The excluded rows keep every internal label of the block they leave.
  const labels = r.extraInternalCategories.filter((e) => e.block === rows.id)
  r.extraInternalCategories.push(...labels.map((e) => ({ ...e, block: shownIn })))
}

const freshnessOf = (p: RecipePrerequisite) =>
  p.kind === 'source' && p.freshness !== undefined ? p.freshness : DEFAULT_FRESHNESS

/** Whether a check of `after` is at least as strict as the same check of `before`. */
function checkLoosening(
  before: RecipeCheck,
  after: RecipeCheck,
): 'check_class_lowered' | 'check_weakened' | 'threshold_loosened' | null {
  if (CLASS_RANK[checkClassOf(after.kind)] < CLASS_RANK[checkClassOf(before.kind)]) {
    return 'check_class_lowered'
  }
  if (before.kind === 'bounded_text' && after.kind === 'bounded_text') {
    if (
      before.maxChars !== undefined &&
      (after.maxChars === undefined || after.maxChars > before.maxChars)
    ) {
      return 'threshold_loosened'
    }
    const phrases = new Set(after.forbiddenPhrases.map(nfc))
    const kept =
      before.forbiddenPhrases.every((p) => phrases.has(nfc(p))) &&
      (!before.connectorsWithoutData || after.connectorsWithoutData) &&
      same(
        { ...before, maxChars: null, forbiddenPhrases: null, connectorsWithoutData: null },
        { ...after, maxChars: null, forbiddenPhrases: null, connectorsWithoutData: null },
      )
    return kept ? null : 'check_weakened'
  }
  return same(before, after) ? null : 'check_weakened'
}

/**
 * Every way `after` is less strict than `before`, in the words of the PM: a check, a mandatory
 * section, a prerequisite, a rule of the writer or of the reviewer, an internal label or an
 * exclusion taken away or weakened, a threshold loosened, an internal section brought into the
 * version for the client, or anything a change in words may not touch (parameters, title,
 * purpose, audience, render). Empty when `after` only tightens or adds.
 */
export function recipeLoosenings(before: Recipe, after: Recipe, lang: Lang): PatchRefusal[] {
  const refuse = new Refusals(lang)
  if (!same(before.parameters, after.parameters)) refuse.add('parameters_changed')
  const kept = new Set(after.sections.map((s) => s.id))
  const afterBlocks = blockIndex(after)
  const top = (r: Recipe) => ({
    schema: r.schema,
    slug: r.slug,
    title: r.title,
    purpose: r.purpose,
    audience: r.audience,
    lang: r.lang,
    examples: r.examples,
    formats: r.render.formats,
    template: r.render.template,
  })
  const renderOf = (r: Recipe) => ({
    sections: r.render.sections.filter((s) => kept.has(s.section)),
    namedCells: r.render.namedCells.filter((c) => afterBlocks.has(c.block)),
  })
  const order = (r: Recipe) => r.sections.map((s) => s.id).filter((id) => kept.has(id))
  if (
    !same(top(before), top(after)) ||
    !same(renderOf(before), renderOf(after)) ||
    !same(
      order(before),
      order(after).filter((id) => before.sections.some((s) => s.id === id)),
    )
  ) {
    refuse.add('recipe_changed')
  }
  // The client version only on the PM's explicit choice: the condition may be added, never
  // taken away or pointed at another choice or option.
  if (
    before.clientVersionWhen !== undefined &&
    !same(before.clientVersionWhen, after.clientVersionWhen)
  ) {
    refuse.add('client_version_condition_changed')
  }

  const lists = new Set((after.exclusions ?? []).map((e) => e.shownIn))
  for (const sb of before.sections) {
    const sa = after.sections.find((s) => s.id === sb.id)
    const named = { section: sb.title }
    if (sa === undefined) {
      if (sb.required || !sb.removable) refuse.add('section_removed', named)
      continue
    }
    if (sb.required && !sa.required) refuse.add('section_made_optional', named)
    if (!sb.removable && sa.removable) refuse.add('section_made_removable', named)
    if (sb.version === 'internal' && sa.version !== 'internal') {
      refuse.add('section_to_client', named)
    }
    let changed = sb.title !== sa.title
    const afterIds = sa.blocks.map((b) => b.id)
    const stayed = afterIds.filter((id) => sb.blocks.some((b) => b.id === id))
    if (
      !same(
        stayed,
        sb.blocks.map((b) => b.id),
      )
    )
      changed = true
    // Only the list of an exclusion may join a section.
    if (afterIds.some((id) => !stayed.includes(id) && !lists.has(id))) changed = true
    for (const bb of sb.blocks) {
      const ba = sa.blocks.find((b) => b.id === bb.id)
      if (ba === undefined) continue
      if (bb.kind === 'text_slot' && ba.kind === 'text_slot') {
        if (ba.maxChars > bb.maxChars) {
          refuse.add('threshold_loosened', {
            name: recipeText('patch', 'threshold_length', { name: bb.title ?? sb.title }, lang),
          })
        }
        if (!same({ ...bb, maxChars: 0 }, { ...ba, maxChars: 0 })) changed = true
      } else if (!same(bb, ba)) {
        changed = true
      }
    }
    if (changed) refuse.add('section_changed', named)
  }

  for (const pb of before.prerequisites) {
    const name = prerequisiteName(pb, lang)
    const pa = after.prerequisites.find((p) => prerequisiteKey(p) === prerequisiteKey(pb))
    if (pa === undefined) {
      refuse.add('prerequisite_removed', { name })
      continue
    }
    if (pb.level === 'required' && pa.level !== 'required') {
      refuse.add('prerequisite_made_optional', { name })
    }
    const fb = freshnessOf(pb)
    const fa = freshnessOf(pa)
    if (fa.warnAfterHours > fb.warnAfterHours || fa.stopAfterHours > fb.stopAfterHours) {
      refuse.add('threshold_loosened', {
        name: recipeText('patch', 'threshold_freshness', { name }, lang),
      })
    }
    const rest = (p: RecipePrerequisite) => ({ ...p, level: null, freshness: null })
    if (!same(rest(pb), rest(pa))) refuse.add('prerequisite_removed', { name })
  }

  const textsKept = (b: readonly string[], a: readonly string[], code: PatchRefusalCode) => {
    const present = new Set(a.map(nfc))
    for (const t of b) if (!present.has(nfc(t))) refuse.add(code, { text: t })
  }
  textsKept(before.rules, after.rules, 'rule_removed')
  textsKept(before.redTeamRules, after.redTeamRules, 'red_team_rule_removed')

  for (const cb of before.checks) {
    const ca = after.checks.find((c) => c.id === cb.id)
    if (ca === undefined) {
      refuse.add('check_removed', { name: cb.label })
      continue
    }
    const loosened = checkLoosening(cb, ca)
    if (loosened === 'threshold_loosened') {
      refuse.add(loosened, {
        name: recipeText('patch', 'threshold_length', { name: cb.label }, lang),
      })
    } else if (loosened !== null) {
      refuse.add(loosened, { name: cb.label })
    }
  }

  const beforeBlocks = blockIndex(before)
  for (const e of before.extraInternalCategories) {
    // A label goes with its block only when a removable section goes.
    if (!afterBlocks.has(e.block)) continue
    if (!after.extraInternalCategories.some((x) => same(x, e))) {
      const b = beforeBlocks.get(e.block)
      const block = b?.block
      const name =
        block !== undefined && e.column !== undefined && 'columns' in block
          ? (block.columns.find((c) => c.id === e.column)?.title ?? '')
          : block?.kind === 'data_value'
            ? block.label
            : ''
      refuse.add('category_removed', { name })
    }
  }

  for (const e of before.exclusions ?? []) {
    if (!afterBlocks.has(e.block)) continue
    const a = (after.exclusions ?? []).find((x) => x.block === e.block)
    const values = new Set(a?.field === e.field ? a.values : [])
    if (a === undefined || a.shownIn !== e.shownIn || e.values.some((v) => !values.has(v))) {
      refuse.add('exclusion_removed')
    }
  }

  labelsBypassed(before, after, refuse)
  blockIdsReused(before, after, refuse)

  // What the writer or the reviewer is newly told may only tighten, never switch a control off.
  const newTexts = [
    ...after.rules.filter((t) => !before.rules.some((b) => nfc(b) === nfc(t))),
    ...after.redTeamRules.filter((t) => !before.redTeamRules.some((b) => nfc(b) === nfc(t))),
    ...[...afterBlocks.values()].flatMap(({ block }) =>
      block.kind === 'text_slot' && !beforeBlocks.has(block.id) ? [block.instructions] : [],
    ),
  ]
  for (const t of newTexts) if (loosensInWords(t, lang)) refuse.add('rule_loosening', { text: t })
  return refuse.list
}

/** Where the rows of a query come from, so two blocks reading the same field can be compared. */
function sourceKey(r: Recipe, q: RecipeQuery): string {
  switch (q.kind) {
    case 'tracker':
      return q.groupBy === undefined ? 'tracker' : `tracker_counts:${q.groupBy}`
    case 'system_rows':
      return `system_rows:${q.view}`
    case 'facts':
      return `facts:${q.factKind}`
    case 'evidence':
      return 'evidence'
    case 'parameter': {
      const type = r.parameters.find((p) => p.id === q.parameter)?.type
      if (type === 'work_item_selection') return 'tracker'
      if (type === 'evidence_selection') return 'evidence'
      return `parameter:${q.parameter}`
    }
  }
}

/**
 * A new block in a version for the client may not show a field of a source at a category less
 * restrictive than the one the current version gives it anywhere (an internal label, or a stricter
 * declaration): taking a labelled datum out under a new name, a new section or a section removed
 * and added again, would bring it to the client.
 */
function labelsBypassed(before: Recipe, after: Recipe, refuse: Refusals): void {
  // What every (source, field) is worth today: the most restrictive category any block gives it.
  // A field column counts with its effective category; a computed column or a value counts only
  // through an internal label on it, which then holds for every field it is computed from.
  const held = new Map<string, DataCategory>()
  const hold = (keys: ReadonlySet<string>, category: DataCategory) => {
    for (const key of keys) {
      const known = held.get(key)
      held.set(key, known === undefined ? category : mostRestrictiveOf([known, category]))
    }
  }
  const labelled = (r: Recipe, block: string, column?: string) =>
    r.extraInternalCategories.some((e) => e.block === block && e.column === column)
  const was = fieldResolver(before, new Set())
  for (const { block } of blockIndex(before).values()) {
    if (block.kind === 'data_table' || block.kind === 'data_list') {
      for (const c of block.columns) {
        if (c.from.kind !== 'field' && !labelled(before, block.id, c.id)) continue
        const category = effectiveCategory(before, block.id, c.id) ?? MOST_RESTRICTIVE_CATEGORY
        hold(was.column(block.id, c.id).keys, category)
      }
    } else if (block.kind === 'data_value' && labelled(before, block.id)) {
      hold(
        was.value(block.id).keys,
        effectiveCategory(before, block.id) ?? MOST_RESTRICTIVE_CATEGORY,
      )
    }
  }
  const lowered = (keys: ReadonlySet<string>, shown: DataCategory | null) =>
    [...keys].some((key) => {
      const h = held.get(key)
      return h !== undefined && shown !== h && (shown === null || !isMoreRestrictive(shown, h))
    })
  if (after.audience === 'internal') return

  // What a client sees and is new, changed, or derived from something new or changed — through
  // any chain of values and columns, internal intermediates included — never shows a field below
  // what it is worth today.
  const beforeIndex = blockIndex(before)
  const afterIndex = blockIndex(after)
  // Touched: new, changed, or moved — to another section, or out of an internal one.
  const touched = new Set(
    [...afterIndex]
      .filter(([id, { block, section }]) => {
        const was = beforeIndex.get(id)
        return (
          was === undefined ||
          !same(was.block, block) ||
          was.section.id !== section.id ||
          was.section.version !== section.version ||
          was.section.version === 'internal'
        )
      })
      .map(([id]) => id),
  )
  const now = fieldResolver(after, touched)
  for (const [id, { block, section }] of afterIndex) {
    if (section.version === 'internal') continue
    if (block.kind === 'data_table' || block.kind === 'data_list') {
      for (const c of block.columns) {
        const item = now.column(id, c.id)
        if (item.touched && lowered(item.keys, effectiveCategory(after, id, c.id))) {
          refuse.add('label_bypassed', { name: c.title })
        }
      }
    } else if (block.kind === 'data_value') {
      const item = now.value(id)
      if (item.touched && lowered(item.keys, effectiveCategory(after, id))) {
        refuse.add('label_bypassed', { name: block.label })
      }
    }
  }

  // Belt and braces: a labelled section taken away and data for the client added in one change.
  const removedLabelled = before.sections.some(
    (s) =>
      !after.sections.some((x) => x.id === s.id) &&
      s.blocks.some((b) => before.extraInternalCategories.some((e) => e.block === b.id)),
  )
  // Data the client did not see before: new blocks, and blocks out of an internal section.
  const clientVisible = (r: Recipe, section: RecipeSection | undefined) =>
    section !== undefined && r.audience !== 'internal' && section.version !== 'internal'
  const addsClientData = [...afterIndex].some(
    ([id, { block, section }]) =>
      clientVisible(after, section) &&
      !clientVisible(before, beforeIndex.get(id)?.section) &&
      (block.kind === 'data_table' || block.kind === 'data_list' || block.kind === 'data_value'),
  )
  if (removedLabelled && addsClientData) refuse.add('labelled_section_replaced')
}

/** A block of a removed section that comes back under the same name, anywhere. */
function blockIdsReused(before: Recipe, after: Recipe, refuse: Refusals): void {
  const afterIndex = blockIndex(after)
  for (const s of before.sections) {
    if (after.sections.some((x) => x.id === s.id)) continue
    if (s.blocks.some((b) => afterIndex.has(b.id)))
      refuse.add('block_id_reused', { section: s.title })
  }
}

interface Resolved {
  /** The (source, field) pairs a column or a value is computed from. */
  keys: Set<string>
  /** Whether a block it is computed from, itself included, is new or changed. */
  touched: boolean
}

/** Resolves columns and values of a recipe down to the fields of the sources they read. */
function fieldResolver(r: Recipe, touched: ReadonlySet<string>) {
  const index = blockIndex(r)
  const empty = (id: string): Resolved => ({ keys: new Set(), touched: touched.has(id) })
  const merge = (into: Resolved, from: Resolved) => {
    for (const k of from.keys) into.keys.add(k)
    into.touched ||= from.touched
  }
  const column = (blockId: string, columnId: string, seen = new Set<string>()): Resolved => {
    const out = empty(blockId)
    const mark = `c:${blockId}.${columnId}`
    if (seen.has(mark)) return out
    seen.add(mark)
    const block = index.get(blockId)?.block
    if (block?.kind !== 'data_table' && block?.kind !== 'data_list') return out
    const c = block.columns.find((x) => x.id === columnId)
    if (c === undefined) return out
    if (c.from.kind === 'field') out.keys.add(`${sourceKey(r, block.query)}\u001f${c.from.field}`)
    else {
      merge(out, column(blockId, c.from.left, seen))
      merge(out, column(blockId, c.from.right, seen))
    }
    return out
  }
  const value = (id: string, seen = new Set<string>()): Resolved => {
    const out = empty(id)
    if (seen.has(`v:${id}`)) return out
    seen.add(`v:${id}`)
    const block = index.get(id)?.block
    if (block?.kind !== 'data_value') return out
    const c = block.compute
    switch (c.op) {
      case 'count':
        out.touched ||= touched.has(c.block)
        break
      case 'sum':
      case 'min':
      case 'max':
        merge(out, column(c.column.block, c.column.column, seen))
        break
      case 'ratio':
      case 'difference':
        for (const ref of [c.left, c.right]) if ('value' in ref) merge(out, value(ref.value, seen))
        break
      case 'parameter':
        break
    }
    return out
  }
  return { column: (b: string, c: string) => column(b, c), value: (id: string) => value(id) }
}

/** The form a rule is read in: the phrase form of the gates (canonical, lookalikes as Latin), no accents. */
const foldRule = (t: string) =>
  phraseForm(t).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’‘`]/g, "'")

/**
 * Phrases of a rule that switch a control off rather than tighten one: ignore, skip, do not
 * signal, omit the sources, accept anyway, bring costs or rates into the document. A false
 * positive is fixed by narrowing the phrase, never by widening what a rule may say.
 */
const LOOSENING_PHRASES: Readonly<Record<Lang, readonly RegExp[]>> = {
  it: [
    /\b(?:ignora|ignorare|ignorate|ignori)\b/,
    /\bnon (?:applicare|applicate|considerare|considerate|segnalare|segnalate|controllare|controllate|verificare|verificate|bloccare|rispettare|seguire|fermare)\b/,
    /\bevita(?:re)? di (?:segnalare|controllare|verificare|bloccare)\b/,
    /\b(?:salta|saltare|saltate|tralascia|tralasciare|trascura|trascurare|disattiva|disattivare|disabilita|disabilitare|sopprimi|sopprimere)\b/,
    /\b(?:ometti|omettere|togli|togliere|elimina|eliminare|rimuovi|rimuovere|nascondi|nascondere)\b.{0,40}\b(?:fonti?|note|anomali[ae]|avvisi|avvertenz[ae]|contraddizion[ei]|freschezz[ae]|controll[oi]|verifich[ae])\b/,
    /(?<!\bnon )(?<!\bmai )\b(?:includi|includere|inserisci|inserire|mostra|mostrare|riporta|riportare|aggiungi|aggiungere|esponi|esporre)\b.{0,60}\b(?:cost[oi]|tariff[ae]|margin[ei]|stim[ae])\b/,
    /\b(?:approva|approvare|accetta|accettare)\b.{0,30}\b(?:sempre|comunque|senza)\b/,
    /\b(?:scrivi|riporta|indica|usa|metti|inserisci)\b[^.]{0,40}\bsenza (?:le |la |una |alcuna )?(?:fonti?|controll[oi]|verifich[ae]|verifica)\b/,
  ],
}

const LETTER = /\p{L}/u

/**
 * The letters a rule may be written with: in Italian the ASCII letters and the Latin letters
 * whose decomposition is one ASCII letter with its accents (à, è, é, ì, ò, ù…). Lookalikes of
 * the Latin alphabet itself (ı, ɪ, ɡ, ʟ, ɑ) are not letters of a rule.
 */
const PLAIN_LETTER: Readonly<Record<Lang, (ch: string) => boolean>> = {
  it: (ch) => /^[A-Za-z]$/.test(ch.normalize('NFKD').replace(/\p{M}/gu, '')),
}

/** Whether a text for the writer or the reviewer would loosen the recipe, or reads as an injection. */
function loosensInWords(text: string, lang: Lang): boolean {
  // Invisible characters or letters of another alphabet can split or disguise a phrase: a rule
  // is written plainly, or not at all.
  if (withoutInvisible(text) !== text || hasForeignLetters(text, lang)) return true
  if (![...text].every((ch) => !LETTER.test(ch) || PLAIN_LETTER[lang](ch))) return true
  if (detectSuspicious([{ text }], lang).length > 0) return true
  const folded = foldRule(text)
  return LOOSENING_PHRASES[lang].some((re) => re.test(folded))
}

/** A refusal of a change in words, with its text for the PM. */
export function patchRefusal(
  code: PatchRefusalCode,
  params: MessageParams,
  lang: Lang,
): PatchRefusal {
  return { code, params, text: recipeText('patch', code, params, lang) }
}

/** What a default value is, in words: the label of a choice, a period or a day as written. */
function shownDefault(r: Recipe, id: string, value: unknown, lang: Lang): string {
  const p = r.parameters.find((x) => x.id === id)
  if (p?.type === 'choice') return p.options.find((o) => o.value === value)?.label ?? ''
  if (typeof value === 'object' && value !== null && 'from' in value && 'to' in value) {
    return periodText(String(value.from), String(value.to), lang)
  }
  if (p?.type === 'date' && typeof value === 'string') return formatDay(value)
  return String(value)
}

/**
 * Applies a patch proposed for `current`, the version in use: the operations, then the
 * validation of the result, then the comparison with `current`. Refused, with the reasons for the
 * PM, when the patch is malformed, names what the recipe does not have, gives an invalid recipe,
 * loosens anything or changes nothing. Otherwise the new version (the next minor one), its
 * differences in words and the default values to save in the project.
 */
export function applyRecipePatch(
  current: Recipe,
  patch: unknown,
  lang: Lang,
  options: PatchOptions = {},
): PatchResult {
  const refuse = new Refusals(lang)
  const parsed = recipePatchSchema.safeParse(patch)
  if (!parsed.success) {
    refuse.add('patch_malformed')
    return { ok: false, refusals: refuse.list }
  }
  const draft = structuredClone(current)
  const defaults: Record<string, unknown> = {}
  applyOperations(draft, parsed.data.operations, defaults, refuse, lang)
  if (refuse.list.length > 0) return { ok: false, refusals: refuse.list }

  const ids = Object.keys(defaults)
  // A default that asks for the client version would give it to every run the PM leaves as is.
  const when = current.clientVersionWhen
  if (when !== undefined && Object.hasOwn(defaults, when.parameter)) {
    if (same(defaults[when.parameter], when.equals)) {
      refuse.add('client_version_by_default', { name: current.title })
    }
  }
  if (ids.length > 0) {
    if (options.scope === 'library') refuse.add('default_only_in_project')
    else {
      const v = validateProjectRecipeSettings(current, {
        parameterDefaults: defaults,
        templateRef: null,
        mapping: null,
        labels: {},
      })
      // The client version by default is already refused in its own words.
      const other = v.ok ? [] : v.errors.filter((e) => e.code !== 'client_version_by_default')
      if (other.length > 0) {
        const name = current.parameters.find((p) => ids.includes(p.id))?.label ?? ''
        refuse.add('default_invalid', { name })
      }
    }
  }

  const loosenings = recipeLoosenings(current, draft, lang)
  const valid = validateRecipe({ ...draft, version: nextVersion(current.version) })
  const invalid: PatchRefusal[] = valid.ok
    ? []
    : valid.errors.map((e) => ({ code: e.code, params: e.params, text: recipeErrorText(e, lang) }))
  const refusals = [...refuse.list, ...loosenings, ...invalid]
  if (refusals.length > 0 || !valid.ok) return { ok: false, refusals }

  const changes = diffRecipes(current, valid.recipe, lang)
  if (changes.length === 0 && ids.length === 0) {
    refuse.add('nothing_to_change')
    return { ok: false, refusals: refuse.list }
  }
  const defaultTexts = ids.map((id) =>
    recipeText(
      'patch',
      'default_set',
      {
        name: current.parameters.find((p) => p.id === id)?.label ?? '',
        value: shownDefault(current, id, defaults[id], lang),
      },
      lang,
    ),
  )
  return {
    ok: true,
    patch: parsed.data,
    recipe: changes.length === 0 ? current : valid.recipe,
    changes,
    parameterDefaults: defaults,
    summary: [...changes.map((c) => c.text), ...defaultTexts].join(' '),
  }
}
