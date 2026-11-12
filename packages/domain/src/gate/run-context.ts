import type { VerifiedAnswer } from '../answer-check.ts'
import type { Lang } from '../language/index.ts'
import { hasClientVersion } from '../recipe/client-version-condition.ts'
import type { CitedSources } from '../recipe/data-reader.ts'
import { type FileAudience, fileAudiences } from '../recipe/deliverable.ts'
import type { Recipe } from '../recipe/format.ts'
import type { GatheredData } from '../recipe/gathered.ts'
import type { SourceAudience } from '../search.ts'
import type { SuspiciousHit } from '../suspicious.ts'
import type { Acceptance } from './acceptance.ts'
import { clientPolicy } from './client-policy.ts'
import type { DeclaredValue } from './common-gates.ts'
import type { PmDecision } from './decisions.ts'
import type { RedTeamContext } from './red-team.ts'

// What a run keeps to judge its drafts again, and the context of the red-team built from it. The
// job judges a draft with it when it is written; the approval judges the same stored draft again
// with it, by the code alone, without the model and without trusting the stored checks.

/** The context the gates judge the drafts of a run with: written once, with the snapshot. */
export interface RunGateContext {
  referenceTime: string
  parameterTexts: GatheredData['parameterTexts']
  periods: GatheredData['periods']
  contradictions: GatheredData['contradictions']
  contestedFacts: GatheredData['contestedFacts']
  context: GatheredData['context']
  /**
   * The typed parameters of the run: they decide whether it has a client version. A context
   * written before they were kept has none, and a recipe that asks the PM then has no client
   * version (the restrictive default).
   */
  parameters?: GatheredData['parameters']
}

export function gateContextOf(g: GatheredData): RunGateContext {
  return {
    referenceTime: g.referenceTime,
    parameterTexts: g.parameterTexts,
    periods: g.periods,
    contradictions: g.contradictions,
    contestedFacts: g.contestedFacts,
    context: g.context,
    parameters: g.parameters,
  }
}

/** Whether a run has a client version: projected, judged, frozen at approval and rendered. */
export function runHasClientVersion(recipe: Recipe, gate: RunGateContext): boolean {
  return hasClientVersion(recipe, gate.parameters ?? {})
}

/** The files a run renders after its approval: the client one only when it has that version. */
export function runFileAudiences(recipe: Recipe, gate: RunGateContext): FileAudience[] {
  const client = runHasClientVersion(recipe, gate)
  return fileAudiences(recipe.audience).filter((a) => a === 'internal' || client)
}

/** What the red-team of a draft of a run reads besides the draft. */
export interface RunRedTeamInputs {
  recipe: Recipe
  gate: RunGateContext
  /** Names of people and organizations of the project. */
  knownNames: readonly string[]
  /** What storage knows now of the evidence and facts the draft cites, and of its trackers. */
  cited: CitedSources & { trackerKinds?: Readonly<Record<string, string>> }
  suspicious: Readonly<Record<string, readonly SuspiciousHit[]>>
  declaredValues: readonly DeclaredValue[]
  /** The checks of the verifier on each text slot. */
  verifications: Readonly<Record<string, VerifiedAnswer>>
  acceptances: readonly Acceptance[]
  decisions: readonly PmDecision[]
  /** The answer of the model reviewer, when it ran for this draft. */
  reviewer?: { findings: unknown }
  /**
   * Whose data each tracker holds now, when the draft is judged again (at the approval): a
   * tracker the PM made internal since the gathering is internal, never the other way round.
   */
  currentTrackers?: Readonly<Record<string, SourceAudience>>
  /**
   * The instant the age of the sources is judged at: the reference time of the run by default;
   * the time of the approval when a draft is judged again before approving it.
   */
  now?: string
}

/**
 * Whose data each tracker holds for the gate: the client's only when it was at the gathering and,
 * when known, still is now; internal otherwise.
 */
export function restrictiveTrackers(
  stored: Readonly<Record<string, SourceAudience>>,
  current: Readonly<Record<string, SourceAudience>> | undefined,
): Record<string, SourceAudience> {
  const out: Record<string, SourceAudience> = {}
  for (const [id, audience] of Object.entries(stored)) {
    const now =
      current === undefined ? audience : Object.hasOwn(current, id) ? current[id] : 'internal'
    out[id] = audience === 'client' && now === 'client' ? 'client' : 'internal'
  }
  return out
}

/** The context of the red-team of a draft of a run. */
export function runRedTeamContext(i: RunRedTeamInputs): RedTeamContext {
  const g = i.gate.context
  const evidence = {
    ...g.evidence,
    ...Object.fromEntries(Object.entries(i.cited.evidence).map(([k, v]) => [k, v.audience])),
  }
  const facts = {
    ...g.facts,
    ...Object.fromEntries(Object.entries(i.cited.facts).map(([k, v]) => [k, v.audience])),
  }
  return {
    recipe: i.recipe,
    lang: i.recipe.lang as Lang,
    parameters: i.gate.parameterTexts,
    periods: i.gate.periods,
    knownNames: i.knownNames,
    freshness: {
      ...g.freshness,
      ...(i.now === undefined ? {} : { now: i.now }),
      sourceKinds: {
        ...g.freshness.sourceKinds,
        ...(i.cited.trackerKinds as RedTeamContext['freshness']['sourceKinds'] | undefined),
      },
      evidence: {
        ...g.freshness.evidence,
        ...Object.fromEntries(
          Object.entries(i.cited.evidence).map(([k, v]) => [
            k,
            { policy: v.policy, sourceKind: v.sourceKind },
          ]),
        ),
      },
      facts: {
        ...g.freshness.facts,
        ...Object.fromEntries(
          Object.entries(i.cited.facts).map(([k, v]) => [k, { policy: v.policy }]),
        ),
      },
    },
    contestedFacts: i.gate.contestedFacts,
    contradictions: i.gate.contradictions,
    declaredValues: i.declaredValues,
    slotVerifications: i.verifications,
    ...(!runHasClientVersion(i.recipe, i.gate)
      ? i.recipe.audience === 'internal'
        ? {}
        : { withoutClientVersion: true as const }
      : {
          client: {
            audience: {
              recipe: i.recipe,
              policy: clientPolicy(),
              evidence,
              facts,
              parameters: i.gate.parameterTexts,
              // As the run found them: a context gathered before is judged restrictively.
              trackers: restrictiveTrackers(g.trackers ?? {}, i.currentTrackers),
            },
          },
        }),
    acceptances: i.acceptances,
    decisions: i.decisions,
    suspicious: i.suspicious,
    remarks: g.remarks ?? {},
    ...(i.reviewer === undefined ? {} : { reviewer: i.reviewer }),
  }
}
