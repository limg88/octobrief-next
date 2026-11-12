import type { Lang } from '../language/index.ts'
import type { DocumentSourceRef } from '../recipe/document-model.ts'
import { recipeText } from '../recipe/messages/index.ts'
import { romeDateString } from '../rome-time.ts'

// The source note of a client file: the generic class of the source and the date of its data
// («Sistema amministrativo, dati al 05/11/2026»), written by the code. Never the title of a piece
// of evidence, never a place in it: the internal version keeps the full titles.

export const CLIENT_SOURCE_CLASSES = [
  'administrative_system',
  'project_backlog',
  'project_document',
  'project_knowledge',
  'pm',
] as const
export type ClientSourceClass = (typeof CLIENT_SOURCE_CLASSES)[number]

/** The keys of the texts of the client notes: one dated and one undated per class. */
export type ClientSourceLabelKey = ClientSourceClass | `${ClientSourceClass}_undated`

/** The generic class of what a source note cites. */
export function clientSourceClass(ref: DocumentSourceRef): ClientSourceClass {
  switch (ref.kind) {
    case 'system_row':
      return 'administrative_system'
    case 'work_item':
    case 'work_item_counts':
      return 'project_backlog'
    case 'evidence':
      return 'project_document'
    case 'fact':
      return 'project_knowledge'
    case 'parameter':
      return 'pm'
  }
}

/** A day in Italy as the PM writes it: `gg/mm/aaaa`. */
function italianDay(instant: string): string {
  const [y, m, d] = romeDateString(new Date(instant)).split('-')
  return `${d}/${m}/${y}`
}

/** The text of a client note: the class and the day of its data, or that the day is unknown. */
export function clientSourceNoteLabel(
  sourceClass: ClientSourceClass,
  dataAsOf: string | null,
  lang: Lang,
): string {
  if (dataAsOf === null) return recipeText('clientSources', `${sourceClass}_undated`, {}, lang)
  return recipeText('clientSources', sourceClass, { date: italianDay(dataAsOf) }, lang)
}

/** Whether a label is the generic note of one of the classes, for this date of the data. */
export function isClientSourceNoteLabel(
  label: string,
  dataAsOf: string | null,
  lang: Lang,
): boolean {
  return CLIENT_SOURCE_CLASSES.some((c) => clientSourceNoteLabel(c, dataAsOf, lang) === label)
}
