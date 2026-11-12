import { LANGS, vocabulary } from './language/index.ts'

// What a source names that is certainly not a person: every word of the whole name, its
// decorations included (tags in brackets, parentheses, what clients add around a name: « - …»,
// « | …»), is a word of a group, a role, a service, a particle or a common word («[PORTALE]» has
// no word of a name either, «Team Delivery», «noreply», «Budget Rischio»). Those are never a
// person's name and are not hidden as one: hiding them blurred the text sent to the model. Any
// name with one other word is a person's, wherever that word stands («LUCA», «Mario Info»,
// «Helpdesk - Mario Rossi», «[Mario Rossi]»). Nothing is deleted: the rule is applied where the
// dictionary is made (`PeopleMatcher`, never to members) and before a source records a name
// without an address (`recordPeopleSeen`).

/** Why a name is certainly not a person's, or null when it may be one. */
export type NotAPersonReason = 'no_letter' | 'tag' | 'group_words'

/**
 * Words that say a name is a group, a place or a service, lower case. A name made only of them
 * (and common words) is not a person; a name with another word is, whatever these words.
 */
export const NOT_A_PERSON_WORDS: readonly string[] = [
  'team',
  'gruppo',
  'group',
  'ufficio',
  'office',
  'servizio',
  'servizi',
  'service',
  'services',
  'supporto',
  'support',
  'helpdesk',
  'noreply',
  'donotreply',
  'admin',
  'administrator',
  'amministrazione',
  'segreteria',
  'commerciale',
  'progetto',
  'project',
  'staff',
  'meeting',
  'riunione',
  'calendario',
  'calendar',
  'mailbox',
  'newsletter',
  'notifiche',
  'notification',
  'notifications',
  'sistema',
  'system',
  'bot',
  'info',
  'sales',
  'marketing',
  'reparto',
  'divisione',
  'division',
  'department',
  'dipartimento',
  'direzione',
  'squad',
  'tribe',
  'comitato',
  'committee',
  'workspace',
  'canale',
  'channel',
  'area',
  'pmo',
  'reply',
  'no',
  'do',
  'not',
  'lead',
  'specialist',
  'consultant',
  'engineer',
  'developer',
  'analyst',
  'coordinator',
  'coordinatore',
  'coordinatrice',
  'director',
  'assistant',
  'sviluppatore',
  'sviluppatrice',
  'analista',
  'product',
  'owner',
  'scrum',
  'it',
  'manager',
  'project',
  'clienti',
  'cliente',
]
const NOT_A_PERSON = new Set(NOT_A_PERSON_WORDS)

const COMMON: ReadonlySet<string> = new Set(
  LANGS.flatMap((lang) => {
    const v = vocabulary(lang)
    return [...v.COMMON_WORDS, ...v.NOT_PERSON_WORDS]
  }),
)
const PARTICLES: ReadonlySet<string> = new Set(
  LANGS.flatMap((lang) => [...vocabulary(lang).NAME_PARTICLES]),
)

/** The words of a name, lower case, split on spaces and the marks names are written with. */
function wordsOf(name: string): string[] {
  return name
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .filter((w) => w !== '')
}

/** Whether a word only says a group, a role or a service (`NOT_A_PERSON_WORDS`). */
export function isGroupWord(word: string): boolean {
  return NOT_A_PERSON.has(word.toLowerCase())
}

/** Whether a word (lower case) only says a group, a role or a service, or is a common word. */
export function isGroupOrCommonWord(word: string): boolean {
  const w = word.toLowerCase()
  return NOT_A_PERSON.has(w) || COMMON.has(w) || PARTICLES.has(w)
}

/**
 * Why `name` is certainly not a person's, or null. Judged on the WHOLE name, its decorations
 * included («Helpdesk - Mario Rossi», «[Mario Rossi]», «Team Lead | Anna Verdi» are people's), an
 * address in angle brackets aside and, for an address, its user name only: no letter at all
 * (`no_letter`), one word alone in brackets, the tag of a subject (`tag`), or every word a word of `NOT_A_PERSON_WORDS`, a particle or a common word
 * (`group_words`).
 */
export function notAPersonReason(raw: string): NotAPersonReason | null {
  const name = raw
    .normalize('NFC')
    .replace(/<[^<>]{0,320}>/gu, ' ')
    .replace(/@[^\s@]{0,320}/gu, ' ')
  const words = wordsOf(name)
  if (words.length === 0) return 'no_letter'
  // A tag of a subject alone, one word in brackets with a capital («[PORTALEQUARZO]»): a label,
  // not a name. All in small letters («[mrossi]») it is a user name, a person's unless it is a
  // common word. A name in brackets with words joined by «.», «_» or «-» («[Mario.Rossi]») is a
  // person's.
  if (words.length === 1 && /^\s*\[[^\s[\]]{1,60}\]\s*$/u.test(name) && /\p{Lu}/u.test(name)) {
    return 'tag'
  }
  if (words.every((w) => isGroupOrCommonWord(w))) return 'group_words'
  return null
}

/** Whether `name` may be a person's name (`notAPersonReason` finds nothing). */
export function looksLikePersonName(name: string): boolean {
  return notAPersonReason(name) === null
}
