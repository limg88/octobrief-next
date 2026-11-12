import type { DocumentKind } from '../../classification.ts'
import type { AcceptanceRefusal } from '../../gate/acceptance.ts'
import type { ApprovalTextKey, ConfirmationRefusal } from '../../gate/approval.ts'
import type { AudienceTextKey } from '../../gate/audience.ts'
import type { ClientSourceLabelKey } from '../../gate/client-source-note.ts'
import type { DecisionRefusal } from '../../gate/decisions.ts'
import type { RedTeamTextKey } from '../../gate/red-team-model.ts'
import type { FactKind } from '../../knowledge.ts'
import type { Lang } from '../../language/index.ts'
import type { DataCategory } from '../categories.ts'
import type { CheckKind } from '../checks.ts'
import type { DeliverableTextKey } from '../deliverable.ts'
import type { RecipeChangeCode } from '../diff.ts'
import type { RecipeAudience, RenderFormat, SectionVersion } from '../format.ts'
import type { GatheringTextKey } from '../gathered.ts'
import type { MailTextKey } from '../mail.ts'
import type { MinutesTextKey } from '../minutes.ts'
import type { PatchTextKey } from '../patch.ts'
import type { SettingsErrorCode } from '../project-settings.ts'
import type { RenderFinding } from '../render.ts'
import type { RunTextKey } from '../run.ts'
import type { SourceKind } from '../source-kinds.ts'
import type { TemplateRefusal } from '../template.ts'
import type { RecipeErrorCode } from '../validate.ts'
import { it } from './it.ts'

/** Every text the core says about recipes, per language: each code has one. */
export interface RecipeDictionary {
  errors: Readonly<Record<RecipeErrorCode, string>>
  changes: Readonly<Record<RecipeChangeCode, string>>
  /** The generic source notes of a client version. */
  clientSources: Readonly<Record<ClientSourceLabelKey, string>>
  /** The findings of the separation between internal and client version. */
  audience: Readonly<Record<AudienceTextKey, string>>
  /** Why «Accetta così» was refused. */
  acceptance: Readonly<Record<AcceptanceRefusal, string>>
  /** Why a decision of the PM was refused. */
  decision: Readonly<Record<DecisionRefusal, string>>
  /** Why the confirmation of the story points was refused. */
  confirmation: Readonly<Record<ConfirmationRefusal, string>>
  /** The states of a revision and why an action on it is not available. */
  approval: Readonly<Record<ApprovalTextKey, string>>
  /** The findings and the outcome of the red-team. */
  redTeam: Readonly<Record<RedTeamTextKey, string>>
  categories: Readonly<Record<DataCategory, string>>
  audiences: Readonly<Record<RecipeAudience, string>>
  versions: Readonly<Record<SectionVersion, string>>
  formats: Readonly<Record<RenderFormat, string>>
  checkKinds: Readonly<Record<CheckKind, string>>
  documentKinds: Readonly<Record<DocumentKind, string>>
  sourceKinds: Readonly<Record<SourceKind, string>>
  factKinds: Readonly<Record<FactKind, string>>
  /** What a project is told about a library recipe it uses. */
  library: Readonly<Record<'new_version_available' | 'pinned_revoked', string>>
  /** Why the configuration of a recipe in a project is not valid. */
  settings: Readonly<Record<SettingsErrorCode, string>>
  /** Why a template is refused. */
  templates: Readonly<Record<TemplateRefusal, string>>
  /** What the gathering of the data writes: notes, values, the state of the prerequisites. */
  gathering: Readonly<Record<GatheringTextKey, string>>
  /** The states and phases of a run, in the words of a PM. */
  run: Readonly<Record<RunTextKey, string>>
  /** The words of the client mail as a draft to copy, and what the code tells about its recipients. */
  mail: Readonly<Record<MailTextKey, string>>
  /** What the checks of the renderer found, beyond the refusals of a template. */
  render: Readonly<Record<RenderFinding, string>>
  /** The words of the files of a deliverable, and why a render gave no file. */
  deliverable: Readonly<Record<DeliverableTextKey, string>>
  /** Why a change asked in words is refused, and the words of the exclusions. */
  patch: Readonly<Record<PatchTextKey, string>>
  /** What the code tells about the participants of minutes written from a transcript. */
  minutes: Readonly<Record<MinutesTextKey, string>>
}

export type DictionaryGroup = keyof RecipeDictionary

const DICTIONARIES: Readonly<Record<Lang, RecipeDictionary>> = { it }

export function recipeDictionary(lang: Lang): RecipeDictionary {
  return DICTIONARIES[lang]
}

const PLACEHOLDER = /\{([a-zA-Z]+)(?::([a-zA-Z]+))?\}/g

/**
 * The text of `code` in `group`, with its placeholders filled: `{name}` is the parameter as it
 * is, `{category:categories}` the parameter translated through another group of the dictionary.
 */
export function recipeText(
  group: DictionaryGroup,
  code: string,
  params: Readonly<Record<string, string | number>>,
  lang: Lang,
): string {
  const dict = recipeDictionary(lang)
  const table = dict[group] as Readonly<Record<string, string>>
  const template = Object.hasOwn(table, code) ? table[code] : undefined
  if (template === undefined) throw new Error(`recipeText: no text for ${group}.${code}`)
  return template.replace(PLACEHOLDER, (_, name: string, via?: string) => {
    const value = params[name]
    if (value === undefined) return ''
    if (via === undefined) return String(value)
    return recipeText(via as DictionaryGroup, String(value), {}, lang)
  })
}
