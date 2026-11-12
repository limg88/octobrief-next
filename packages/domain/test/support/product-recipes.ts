// The product recipes of `recipes/` as the tests read them, and what a run of them gathers on
// the synthetic projects, written by hand from the generated data: no real data, no model. The
// text slots are the answers a scripted model would give, with the sources the verifier would
// keep.

import { readFileSync } from 'node:fs'
import { SYNTHETIC_NOW } from '../../../../tools/synthetic/src/generate.ts'
import {
  type AudienceContext,
  buildSkeleton,
  checkParameterValues,
  clientPolicy,
  type DocumentSourceRef,
  type GatheredBlock,
  type GatheredData,
  type GatheredNote,
  type InternalDocument,
  mergeDocument,
  type ParameterValues,
  parameterTitleTexts,
  periodsOf,
  type Recipe,
  type RecipeChecksContext,
  recipeText,
  type SlotContent,
  type SlotSegment,
  type SlotSource,
} from '../../src/recipe/index.ts'
import { recipeOf } from './client-version.ts'

export const NOW = SYNTHETIC_NOW.toISOString()

/** A recipe of the library as it is published: the file must hold a valid recipe. */
export function productRecipe(file: string): Recipe {
  const raw = JSON.parse(
    readFileSync(new URL(`../../../../recipes/${file}`, import.meta.url), 'utf8'),
  ) as { changeSummary?: unknown; recipe?: unknown }
  if (typeof raw.changeSummary !== 'string') throw new Error(`${file}: no changeSummary`)
  return recipeOf(raw.recipe as Record<string, unknown>)
}

/** A place of a piece of evidence: its paragraph (a cue of a transcript, a line of a document). */
export const evidenceRef = (evidenceId: string, index: number): DocumentSourceRef => ({
  kind: 'evidence',
  evidenceId,
  locator: { kind: 'paragraph', index },
})

/** What a run of `recipe` gathered with these parameters, blocks and notes of the places read. */
export function gatheredFor(
  recipe: Recipe,
  values: ParameterValues,
  blocks: Record<string, GatheredBlock> = {},
  notes: GatheredNote[] = [],
): GatheredData {
  const parameters = checkParameterValues(recipe, values)
  const parameterNotes = recipe.parameters
    .filter((p) => Object.hasOwn(parameters, p.id))
    .map((p) => ({
      ref: { kind: 'parameter', parameterId: p.id } as DocumentSourceRef,
      label: recipeText('gathering', 'note_parameter', { name: p.label }, 'it'),
      dataAsOf: null,
    }))
  return {
    recipe: { slug: recipe.slug, version: recipe.version },
    lang: 'it',
    referenceTime: NOW,
    parameters,
    parameterTexts: parameterTitleTexts(recipe, parameters, 'it'),
    periods: periodsOf(parameters),
    blocks,
    notes: [...parameterNotes, ...notes],
    readLog: [],
    freshness: [],
    contradictions: [],
    contestedFacts: [],
    removedEvidence: [],
    context: {
      evidence: {},
      facts: {},
      freshness: {
        now: NOW,
        thresholds: { warnAfterHours: 24, stopAfterHours: 72 },
        sourceKinds: {},
        evidence: {},
        facts: {},
      },
    },
  }
}

/** A source of a segment as the verifier keeps it. */
export function source(
  ref: DocumentSourceRef,
  label: string,
  category: SlotSource['category'] = 'other',
): SlotSource {
  return { ref, label, clientLabel: 'Documento di progetto', dataAsOf: NOW, category }
}

/** A segment of a text slot. */
export function said(
  text: string,
  sources: SlotSource[] = [],
  nature: SlotSegment['nature'] = 'fact',
  category: SlotSegment['category'] = 'other',
): SlotSegment {
  return { text, nature, category, sources }
}

/** The internal draft of a run: the skeleton the code builds and the slots the model wrote. */
export function draftOf(
  recipe: Recipe,
  gathered: GatheredData,
  slots: Record<string, SlotContent>,
): InternalDocument {
  const { skeleton } = buildSkeleton(recipe, gathered)
  const doc = mergeDocument(skeleton, slots)
  if (doc.audience !== 'internal') throw new Error('the draft of a run is internal')
  return doc
}

/** The context of the checks of a recipe on a draft of it. */
export function checksContext(recipe: Recipe, gathered: GatheredData): RecipeChecksContext {
  return {
    recipe,
    lang: 'it',
    parameters: gathered.parameterTexts,
    periods: gathered.periods,
    declaredValues: [],
  }
}

/** What the client gate knows of a run: the evidence it cites, by id. */
export function audienceOf(
  recipe: Recipe,
  gathered: GatheredData,
  evidence: AudienceContext['evidence'] = {},
): AudienceContext {
  return {
    recipe,
    policy: clientPolicy(),
    evidence,
    facts: {},
    parameters: gathered.parameterTexts,
  }
}
