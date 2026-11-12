import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_MIN_MODEL_CALLS,
  DEFAULT_RUN_CAPS,
  MAX_RUN_MODEL_CALLS,
  type Recipe,
  type RunCaps,
  recipeModelCalls,
  runCapsForRecipe,
  runCapsSchema,
} from '../src/recipe/index.ts'
import { recipeOf } from './support/client-version.ts'

// How many model calls a run of a recipe may make. Each text slot takes a turn of the tools and
// a structured answer, the reviewer one call more, and the one automatic cycle may write every
// slot again: a recipe never starts with fewer calls than it needs. While the Admin keeps the
// number of calls automatic, the cap follows the recipe; a number the Admin set stays the ceiling, and a recipe that
// needs more is refused before it starts, with a reason in words.

const library = (file: string): Recipe =>
  recipeOf(
    (
      JSON.parse(readFileSync(new URL(`../../../recipes/${file}`, import.meta.url), 'utf8')) as {
        recipe: Record<string, unknown>
      }
    ).recipe,
  )

const slotsOf = (r: Recipe) =>
  r.sections.flatMap((s) => s.blocks).filter((b) => b.kind === 'text_slot').length

const caps = (maxModelCalls: number | null): RunCaps => ({ ...DEFAULT_RUN_CAPS, maxModelCalls })

describe('the model calls of a run of a recipe', () => {
  it('counts a tool turn and an answer per slot, the reviewer, and the automatic cycle', () => {
    const minutes = library('minutes-from-transcript.json')
    const slots = slotsOf(minutes)
    const draft = 2 * slots + 1
    const calls = recipeModelCalls(minutes)
    expect(calls.needed).toBe(2 * draft)
    expect(calls.withMargin).toBeGreaterThan(calls.needed)
  })

  it('leaves out the reviewer of a recipe without reviewer rules', () => {
    const r = recipeOf()
    const plain = { ...r, redTeamRules: [] }
    expect(recipeModelCalls(plain).needed).toBe(2 * (2 * slotsOf(r)))
  })

  it('lets the minutes run to the end with the default caps', () => {
    const minutes = library('minutes-from-transcript.json')
    const r = runCapsForRecipe(minutes, { ...DEFAULT_RUN_CAPS })
    if (!r.ok) throw new Error('the minutes were refused with the default caps')
    expect(r.caps.maxModelCalls).toBeGreaterThanOrEqual(recipeModelCalls(minutes).needed)
    expect(r.caps.maxModelCalls).toBeLessThanOrEqual(MAX_RUN_MODEL_CALLS)
  })

  it('leaves the number of calls to the recipe by default, never below the floor', () => {
    expect(DEFAULT_RUN_CAPS.maxModelCalls).toBeNull()
    const sal = library('sal-economico.json')
    const r = runCapsForRecipe(sal, { ...DEFAULT_RUN_CAPS })
    expect(r).toEqual({
      ok: true,
      caps: { ...DEFAULT_RUN_CAPS, maxModelCalls: AUTOMATIC_MIN_MODEL_CALLS },
    })
  })

  it('keeps an explicit 20 at 20 and refuses a recipe that needs more', () => {
    const sal = library('sal-economico.json')
    expect(runCapsForRecipe(sal, caps(20))).toEqual({ ok: true, caps: caps(20) })
    const minutes = library('minutes-from-transcript.json')
    expect(runCapsForRecipe(minutes, caps(20))).toMatchObject({
      ok: false,
      code: 'calls_cap_too_low',
      cap: 20,
    })
  })

  it('refuses, without blaming the Admin, a recipe that needs more calls than any run may make', () => {
    const r = recipeOf()
    const slot = r.sections.flatMap((s) => s.blocks).find((b) => b.kind === 'text_slot')
    if (!slot) throw new Error('no slot')
    const blocks = Array.from({ length: 30 }, (_, i) => ({ ...slot, id: 'slot'.concat(String(i)) }))
    const huge: Recipe = {
      ...r,
      sections: [
        ...r.sections,
        {
          id: 'many',
          title: 'Molti testi',
          required: false,
          version: 'internal',
          removable: true,
          blocks,
        },
      ],
    }
    expect(recipeModelCalls(huge).needed).toBeGreaterThan(MAX_RUN_MODEL_CALLS)
    expect(runCapsForRecipe(huge, { ...DEFAULT_RUN_CAPS })).toMatchObject({
      ok: false,
      code: 'calls_beyond_maximum',
    })
  })

  it('stores an automatic number of calls as null, and only numbers between 1 and 100', () => {
    expect(runCapsSchema.safeParse({ ...DEFAULT_RUN_CAPS }).success).toBe(true)
    expect(runCapsSchema.safeParse(caps(20)).success).toBe(true)
    expect(runCapsSchema.safeParse(caps(0)).success).toBe(false)
    expect(runCapsSchema.safeParse(caps(101)).success).toBe(false)
  })

  it('changes nothing but the model calls', () => {
    const minutes = library('minutes-from-transcript.json')
    const r = runCapsForRecipe(minutes, { ...DEFAULT_RUN_CAPS })
    if (!r.ok) throw new Error('refused')
    const { maxModelCalls: _a, ...rest } = r.caps
    const { maxModelCalls: _b, ...defaults } = DEFAULT_RUN_CAPS
    expect(rest).toEqual(defaults)
  })

  it('keeps a cap the Admin set as the ceiling', () => {
    const sal = library('sal-economico.json')
    expect(runCapsForRecipe(sal, caps(12))).toEqual({ ok: true, caps: caps(12) })
    const minutes = library('minutes-from-transcript.json')
    expect(runCapsForRecipe(minutes, caps(80))).toEqual({ ok: true, caps: caps(80) })
  })

  it('refuses before the start a recipe that needs more calls than the Admin allows', () => {
    const minutes = library('minutes-from-transcript.json')
    const r = runCapsForRecipe(minutes, caps(30))
    expect(r).toEqual({
      ok: false,
      code: 'calls_cap_too_low',
      needed: recipeModelCalls(minutes).needed,
      cap: 30,
    })
  })

  it('lets every recipe of the library run with the default caps', () => {
    for (const file of [
      'sal-economico.json',
      'closing-status.json',
      'deliverable-sprint.json',
      'client-mail.json',
      'minutes-from-transcript.json',
      'assessment-phase-deliverable.json',
    ]) {
      expect(runCapsForRecipe(library(file), { ...DEFAULT_RUN_CAPS }).ok, file).toBe(true)
    }
  })
})
