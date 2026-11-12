import type { CheckClass } from '../recipe/checks.ts'
import { canonicalJson } from '../recipe/hash.ts'
import type { AudienceRef } from './audience.ts'

// The common model of the red-team: the gates, their fixed classes and order, the places of the
// findings in a draft and whether the PM resolves an anomaly with «Accetta così» or with a
// decision. Classes and acceptability belong to the code of a finding, never to a flag a stored
// row or the model carries.

/** The common gates, always active, in their fixed order. */
export const COMMON_GATES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export type GateNumber = (typeof COMMON_GATES)[number]

/** The class of every common gate: what may be fixed automatically depends on it. */
export const GATE_CLASS: Readonly<Record<GateNumber, CheckClass>> = Object.freeze({
  1: 'data',
  2: 'data',
  3: 'form',
  4: 'data',
  5: 'data',
  6: 'data',
  7: 'form',
  8: 'structure',
  9: 'data',
  10: 'data',
})

/** How the PM closes an anomaly: an acceptance, a decision with a reason, or a new draft. */
export type Resolution = 'acceptance' | 'decision' | 'none'

interface CodeRule {
  gate: GateNumber | null
  /** `null`: the class comes from the check of the recipe. */
  class: CheckClass | null
  resolution: Resolution
}

/** Every anomaly of the red-team, with its gate, class and how the PM may close it. */
export const RED_TEAM_ANOMALIES = Object.freeze({
  // 1: verified source, with the numbers of the text among those read.
  without_source: { gate: 1, class: 'data', resolution: 'none' },
  source_note_missing: { gate: 1, class: 'data', resolution: 'none' },
  mixed_script: { gate: 1, class: 'data', resolution: 'acceptance' },
  // Found again at approval: a cited source removed at the source since the draft. The PM may
  // accept it, with a reason, like a stale source.
  source_removed: { gate: 1, class: 'data', resolution: 'acceptance' },
  // A text that cites a row the PM excluded, or the passage of a document where the detector
  // found an instruction: data, never corrected by the code; the PM may accept each, with a reason.
  excluded_row_cited: { gate: 1, class: 'data', resolution: 'acceptance' },
  suspicious_passage_cited: { gate: 1, class: 'data', resolution: 'acceptance' },
  // 2: freshness of system data, one anomaly per source.
  stale_source: { gate: 2, class: 'data', resolution: 'acceptance' },
  source_freshness_unknown: { gate: 2, class: 'data', resolution: 'acceptance' },
  source_date_in_future: { gate: 2, class: 'data', resolution: 'acceptance' },
  // 3: link phrases without data, titles with only the data of the parameters.
  connector_with_data: { gate: 3, class: 'form', resolution: 'none' },
  connector_with_name: { gate: 3, class: 'form', resolution: 'acceptance' },
  title_with_data: { gate: 3, class: 'form', resolution: 'none' },
  static_with_data: { gate: 3, class: 'form', resolution: 'none' },
  // 4: «non dedotto» instead of a value without source.
  value_without_source: { gate: 4, class: 'data', resolution: 'none' },
  // 5: internal and client separation (the codes of `checkAudience`).
  internal_data_in_client: { gate: 5, class: 'data', resolution: 'acceptance' },
  internal_note_in_client: { gate: 5, class: 'data', resolution: 'none' },
  internal_section_in_client: { gate: 5, class: 'data', resolution: 'none' },
  client_source_note_not_generic: { gate: 5, class: 'data', resolution: 'none' },
  mixed_script_in_client: { gate: 5, class: 'data', resolution: 'acceptance' },
  client_version_inconsistent: { gate: 5, class: 'data', resolution: 'none' },
  // 6: credentials and secrets, never acceptable.
  credential_in_text: { gate: 6, class: 'data', resolution: 'none' },
  secret_in_text: { gate: 6, class: 'data', resolution: 'none' },
  // 7: paths and technical identifiers.
  technical_path: { gate: 7, class: 'form', resolution: 'acceptance' },
  technical_identifier: { gate: 7, class: 'form', resolution: 'acceptance' },
  // 8: structure of the recipe.
  required_section_missing: { gate: 8, class: 'structure', resolution: 'none' },
  section_unexpected: { gate: 8, class: 'structure', resolution: 'none' },
  section_out_of_order: { gate: 8, class: 'structure', resolution: 'none' },
  blocks_mismatch: { gate: 8, class: 'structure', resolution: 'none' },
  columns_mismatch: { gate: 8, class: 'structure', resolution: 'none' },
  row_cells_mismatch: { gate: 8, class: 'structure', resolution: 'none' },
  // 9 and 10: decided by the PM, with a reason.
  contradiction_open: { gate: 9, class: 'data', resolution: 'decision' },
  declared_value_changed: { gate: 10, class: 'data', resolution: 'decision' },
  // The checks of the recipe, with the class of the catalog.
  recipe_check_failed: { gate: null, class: null, resolution: 'acceptance' },
  recipe_check_not_evaluable: { gate: null, class: null, resolution: 'acceptance' },
  // The model reviewer: always data. A review that did not come back is never «no findings».
  reviewer_finding: { gate: null, class: 'data', resolution: 'acceptance' },
  reviewer_failed: { gate: null, class: 'data', resolution: 'none' },
  // Found again at approval: the recipe or its settings in the project changed since the run.
  recipe_changed: { gate: null, class: 'data', resolution: 'acceptance' },
} as const satisfies Record<string, CodeRule>)
export type RedTeamAnomalyCode = keyof typeof RED_TEAM_ANOMALIES

export const RED_TEAM_ANOMALY_CODES = Object.freeze(
  Object.keys(RED_TEAM_ANOMALIES) as RedTeamAnomalyCode[],
)

/** Warnings: counted apart, never blocking. Story points ask for an explicit confirmation. */
export const RED_TEAM_WARNINGS = Object.freeze({
  story_points_in_client: { gate: 5, requiresConfirmation: true },
  source_freshness_warning: { gate: 2, requiresConfirmation: false },
  suspicious_instruction: { gate: null, requiresConfirmation: false },
  // How a data block was read, for the PM: a tracker left out, a sprint with no work item.
  block_remark: { gate: null, requiresConfirmation: false },
  // The reviewer read only the first rows of a long table: its checks are on a sample.
  reviewer_sample: { gate: null, requiresConfirmation: false },
} as const)
export type RedTeamWarningCode = keyof typeof RED_TEAM_WARNINGS

/** Every text of the red-team the PM reads: one per code, the places and the outcome line. */
export type RedTeamTextKey =
  | RedTeamAnomalyCode
  | RedTeamWarningCode
  | 'unknown_finding'
  | 'credential_in_source_title'
  | 'secret_in_source_title'
  | 'where_document'
  | 'where_section'
  | 'where_block'
  | 'where_column'
  | 'where_internal_note'
  | 'excerpt'
  | 'checks_one'
  | 'checks_other'
  | 'anomalies_one'
  | 'anomalies_other'
  | 'warnings_one'
  | 'warnings_other'

export function isRedTeamAnomalyCode(code: string): code is RedTeamAnomalyCode {
  return Object.hasOwn(RED_TEAM_ANOMALIES, code)
}

export function isRedTeamWarningCode(code: string): code is RedTeamWarningCode {
  return Object.hasOwn(RED_TEAM_WARNINGS, code)
}

/** How the PM may close an anomaly with this code: an unknown code only with a new draft. */
export function resolutionOf(code: string): Resolution {
  return isRedTeamAnomalyCode(code) ? RED_TEAM_ANOMALIES[code].resolution : 'none'
}

/**
 * The place of a finding in the draft: ids of the recipe, row keys and fingerprints of texts,
 * never numbers of notes nor positions the model could shift.
 */
export type RedTeamRef =
  | AudienceRef
  | { element: 'block'; section: string; block: string }
  | { element: 'static'; section: string; block: string }
  | { element: 'cell'; section: string; block: string; row: string; column: string }
  | { element: 'row'; section: string; block: string; row: string }
  /** `segment` is the fingerprint of its text and nature. */
  | { element: 'internal_note'; segment: string }
  /** A source of the project: `evidence:…`, `fact:…`, `system:…` or `tracker:…`. */
  | { element: 'source'; source: string }
  | { element: 'check'; check: string }
  | { element: 'contradiction'; contradiction: string }
  | { element: 'declared_value'; section: string; cell: string }

/** The canonical key of a place. */
export function refKeyOf(ref: RedTeamRef): string {
  return canonicalJson(ref)
}

/** Titles of where a finding is, for the text the PM reads. */
export interface RedTeamPlace {
  section?: string
  block?: string
  column?: string
}

/** A JSON value kept with a finding, for its text and for audit. */
export type DetailValue = string | number | boolean | null | readonly DetailValue[] | DetailObject
export interface DetailObject {
  readonly [key: string]: DetailValue
}

export type AnomalyStatus = 'open' | 'accepted' | 'decided'

export interface RedTeamAnomaly {
  code: RedTeamAnomalyCode
  /** The common gate; `null` for a check of the recipe and for the model reviewer. */
  gate: GateNumber | null
  class: CheckClass
  ref: RedTeamRef
  refKey: string
  /** Fingerprint of the content the anomaly is about: an acceptance holds only for it. */
  contentHash: string
  place: RedTeamPlace
  /** The text slot the anomaly is in: only those can be regenerated by the automatic cycle. */
  slot: string | null
  resolution: Resolution
  status: AnomalyStatus
  detail: DetailObject
}

export interface RedTeamWarning {
  code: RedTeamWarningCode
  gate: GateNumber | null
  ref: RedTeamRef
  refKey: string
  contentHash: string
  place: RedTeamPlace
  requiresConfirmation: boolean
  detail: DetailObject
}
