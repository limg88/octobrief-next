import { isGroupOrCommonWord, looksLikePersonName } from './people-filter.ts'

// People a document names in a way rules can read: who speaks in a transcript («Name Surname:»
// at the start of a line) and who a roster lists («Partecipanti: A, B»). They are remembered
// with the project so that no model reads their names. A name mentioned inside a sentence is
// not found this way: only a list of known people (members, sources) hides it.
// A label of capitalized words at the start of a line may be taken for a name: it is then
// hidden from the model in full and put back afterwards, which costs nothing; the other way
// round (a name left in clear) is what must not happen.

/** Names one document adds at most: a runaway list is cut, never stored whole. */
export const MAX_NAMED_PARTICIPANTS = 200

/** Two to four capitalized words: a first name and a surname, with particles and double names. */
const NAME = String.raw`\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){1,3}`
const SPEAKER = new RegExp(`^(${NAME}):\\s`, 'u')
const WHOLE_NAME = new RegExp(`^${NAME}$`, 'u')
const ROSTER = /^(?:partecipanti|presenti|participants|attendees)\s*:\s*(.+)$/iu

/**
 * The people a text names as speakers or in a roster of participants, each once, in the order
 * they appear. Only what reads as a person's name is kept (never a role, a tag or a heading).
 */
export function namedParticipants(chunks: readonly { text: string }[]): string[] {
  const names = new Set<string>()
  const keep = (candidate: string) => {
    const name = candidate.replace(/\s+/gu, ' ').trim()
    // A label made only of common words («Budget Complessivo:») is not a person; a surname
    // that is also a common word still is, next to a first name.
    const words = name.split(' ')
    if (
      WHOLE_NAME.test(name) &&
      looksLikePersonName(name) &&
      !words.every((word) => isGroupOrCommonWord(word))
    ) {
      names.add(name)
    }
  }
  for (const chunk of chunks) {
    for (const raw of chunk.text.split('\n')) {
      const line = raw.trim()
      const roster = ROSTER.exec(line)
      if (roster?.[1]) for (const entry of roster[1].split(/[,;]/u)) keep(entry)
      const speaker = SPEAKER.exec(line)
      if (speaker?.[1]) keep(speaker[1])
      if (names.size >= MAX_NAMED_PARTICIPANTS) return [...names].slice(0, MAX_NAMED_PARTICIPANTS)
    }
  }
  return [...names]
}
