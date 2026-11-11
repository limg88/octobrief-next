import * as it from './it.ts'

/** Languages the recognizers know. Every function that reads words, dates or numbers takes one. */
export type Lang = 'it'

export const LANGS: readonly Lang[] = ['it']

export type Vocabulary = typeof it

const VOCABULARIES: Readonly<Record<Lang, Vocabulary>> = { it }

export function vocabulary(lang: Lang): Vocabulary {
  return VOCABULARIES[lang]
}
