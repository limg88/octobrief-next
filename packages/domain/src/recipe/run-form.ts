import {
  MAX_PARAMETERS_PER_STEP,
  type Recipe,
  type RecipeParameter,
  TITLE_PLACEHOLDER,
} from './format.ts'
import { blockParameters, sectionParameters } from './gathered.ts'

// What the start of a run asks the PM: the parameters by step, at most five at a time, every one
// skippable, each with what skipping it does to the deliverable. Deterministic, from the recipe
// alone: the page shows it when it opens, without the model.

/** The parameters of a recipe by step, in the order of the steps; at most five per step. */
export function parameterSteps(recipe: Recipe): RecipeParameter[][] {
  const steps = [...new Set(recipe.parameters.map((p) => p.step))].sort((a, b) => a - b)
  return steps.flatMap((step) => {
    const asked = recipe.parameters.filter((p) => p.step === step)
    // A valid recipe never has more in a step; a longer one is split, never shown all at once.
    const out: RecipeParameter[][] = []
    for (let i = 0; i < asked.length; i += MAX_PARAMETERS_PER_STEP) {
      out.push(asked.slice(i, i + MAX_PARAMETERS_PER_STEP))
    }
    return out
  })
}

/** What skipping a parameter does to the deliverable. */
export type SkipEffect =
  /** A mandatory parameter: these sections (their titles as the PM reads them) are «non dedotto». */
  | { kind: 'not_deduced'; sections: string[] }
  /** An optional filter: the blocks that use it read without it, wider («Senza filtro su …»). */
  | { kind: 'filter_dropped' }
  /** The choice of the client version: the deliverable is internal only. */
  | { kind: 'internal_only' }
  /** The table copied from these documents: without the documents the table cannot be given. */
  | { kind: 'rows_need_documents'; tables: string[] }
  /** Nothing the deliverable reads changes. */
  | { kind: 'none' }

/** A title with its parameters written as the PM knows them: «Periodo dello sprint». */
export function shownRecipeTitle(recipe: Recipe, title: string): string {
  const labels = new Map(recipe.parameters.map((p) => [p.id, p.label]))
  return title.replace(TITLE_PLACEHOLDER, (_, id: string) => `«${labels.get(id) ?? '…'}»`)
}

/** What skipping the parameter `id` of `recipe` does; `none` for a parameter it does not have. */
export function skipEffect(recipe: Recipe, id: string): SkipEffect {
  const parameter = recipe.parameters.find((p) => p.id === id)
  if (parameter === undefined) return { kind: 'none' }
  if (recipe.clientVersionWhen?.parameter === id) return { kind: 'internal_only' }
  if (parameter.required) {
    const sections = recipe.sections
      .filter((s) => sectionParameters(s).has(id))
      .map((s) => shownRecipeTitle(recipe, s.title))
    if (sections.length > 0) return { kind: 'not_deduced', sections }
  }
  // Tables given without their documents are refused: the PM must know it before skipping.
  const tables = recipe.parameters
    .filter((p) => p.type === 'rows' && p.evidence === id)
    .map((p) => p.label)
  if (tables.length > 0) return { kind: 'rows_need_documents', tables }
  if (recipe.sections.some((s) => s.blocks.some((b) => blockParameters(b).has(id)))) {
    return { kind: 'filter_dropped' }
  }
  return { kind: 'none' }
}
