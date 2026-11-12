import { z } from 'zod'
import type { Lang } from '../language/index.ts'
import { MAX_LABEL_LENGTH, recipeId } from './checks.ts'
import { type Recipe, type RecipeParameter, renderSchema } from './format.ts'
import { recipeText } from './messages/index.ts'
import {
  type MessageParams,
  type RecipeError,
  type RecipeErrorCode,
  recipeErrorText,
  validateRecipe,
} from './validate.ts'

// The configuration of a recipe in one project: default values of its parameters, the template
// and its mapping, and the labels the deliverables use (for example the names of the features).
// It is validated against the recipe it configures, with the same rules as the recipe itself:
// the template and the mapping are checked by validating the recipe they produce.

export const MAX_PROJECT_LABELS = 200
const MAX_LABEL_KEY_LENGTH = 100
const SLUG = /^[a-z][a-z0-9-]{0,59}$/

const label = z.string().trim().min(1).max(MAX_LABEL_LENGTH)

export const projectRecipeSettingsSchema = z.strictObject({
  parameterDefaults: z.record(recipeId, z.unknown()),
  /** The slug of a template of the library or of the project; the recipe's own when null. */
  templateRef: z.string().regex(SLUG).nullable(),
  /** Replaces the sections and named cells of the recipe's render when set. */
  mapping: z
    .strictObject({
      sections: renderSchema.shape.sections,
      namedCells: renderSchema.shape.namedCells,
    })
    .nullable(),
  labels: z.record(z.string().trim().min(1).max(MAX_LABEL_KEY_LENGTH), label),
})
export type ProjectRecipeSettings = z.infer<typeof projectRecipeSettingsSchema>

export const SETTINGS_ERROR_CODES = [
  'settings_malformed',
  'default_parameter_unknown',
  'default_not_allowed',
  'default_invalid',
  'labels_too_many',
  'client_version_by_default',
] as const
export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number]

export interface SettingsError {
  code: SettingsErrorCode | RecipeErrorCode
  params: MessageParams
  /** Where it is, for the logs only. */
  path: string
}

export type SettingsValidation =
  | { ok: true; settings: ProjectRecipeSettings }
  | { ok: false; errors: SettingsError[] }

const isSettingsCode = (code: string): code is SettingsErrorCode =>
  (SETTINGS_ERROR_CODES as readonly string[]).includes(code)

/** The text of an error for the PM. */
export function settingsErrorText(error: SettingsError, lang: Lang): string {
  if (isSettingsCode(error.code)) return recipeText('settings', error.code, error.params, lang)
  return recipeErrorText(error as RecipeError, lang)
}

const isoDate = z.iso.date()

/** The schema a default value of `parameter` must satisfy; null when it cannot have one. */
function defaultSchema(parameter: RecipeParameter): z.ZodType | null {
  switch (parameter.type) {
    case 'text':
      return z.string().trim().min(1).max(parameter.maxLength)
    case 'date':
      return isoDate
    case 'period':
      return z
        .strictObject({ from: isoDate, to: isoDate })
        .refine((p) => p.from <= p.to, { message: 'period_reversed' })
    case 'choice':
      return z.enum(parameter.options.map((o) => o.value) as [string, ...string[]])
    case 'number': {
      let n = parameter.integer ? z.int() : z.number()
      if (parameter.min !== undefined) n = n.min(parameter.min)
      if (parameter.max !== undefined) n = n.max(parameter.max)
      return n
    }
    // A selection names evidence or work items of the moment, a table copies the document of
    // the moment: the PM gives them each time.
    case 'evidence_selection':
    case 'work_item_selection':
    case 'rows':
      return null
  }
}

/** The recipe as the project renders it: its template and mapping, when the project sets them. */
export function effectiveProjectRecipe(recipe: Recipe, settings: ProjectRecipeSettings): Recipe {
  return {
    ...recipe,
    render: {
      ...recipe.render,
      ...(settings.templateRef === null ? {} : { template: settings.templateRef }),
      ...(settings.mapping === null
        ? {}
        : { sections: settings.mapping.sections, namedCells: settings.mapping.namedCells }),
    },
  }
}

/**
 * Whether `input` is a valid configuration of `recipe` (a valid recipe) in a project: a closed
 * shape, defaults only for the parameters the recipe has and of their type, labels bounded, and a
 * template and mapping that keep the recipe valid.
 */
export function validateProjectRecipeSettings(recipe: Recipe, input: unknown): SettingsValidation {
  const parsed = projectRecipeSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, errors: [{ code: 'settings_malformed', params: {}, path: '' }] }
  }
  const settings = parsed.data
  const errors: SettingsError[] = []
  const parameterDefaults: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(settings.parameterDefaults)) {
    const path = `.parameterDefaults.${id}`
    const parameter = recipe.parameters.find((p) => p.id === id)
    if (parameter === undefined) {
      errors.push({ code: 'default_parameter_unknown', params: {}, path })
      continue
    }
    const schema = defaultSchema(parameter)
    if (schema === null) {
      errors.push({ code: 'default_not_allowed', params: { name: parameter.label }, path })
      continue
    }
    const v = schema.safeParse(value)
    if (!v.success) {
      errors.push({ code: 'default_invalid', params: { name: parameter.label }, path })
      continue
    }
    parameterDefaults[id] = v.data
  }
  // A default that asks for the client version would give it to every run the PM leaves as is.
  const when = recipe.clientVersionWhen
  if (when !== undefined && parameterDefaults[when.parameter] === when.equals) {
    errors.push({
      code: 'client_version_by_default',
      params: { name: recipe.title },
      path: `.parameterDefaults.${when.parameter}`,
    })
  }
  if (Object.keys(settings.labels).length > MAX_PROJECT_LABELS) {
    errors.push({ code: 'labels_too_many', params: { max: MAX_PROJECT_LABELS }, path: '.labels' })
  }
  const effective = validateRecipe(effectiveProjectRecipe(recipe, settings))
  if (!effective.ok) errors.push(...effective.errors)
  return errors.length === 0
    ? { ok: true, settings: { ...settings, parameterDefaults } }
    : { ok: false, errors }
}
