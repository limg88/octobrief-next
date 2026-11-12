import { phraseForm } from '../gate/internal-lexicon.ts'
import type { Lang } from '../language/index.ts'
import type { DeliverableDocument } from './document-model.ts'
import { recipeText } from './messages/index.ts'

// The participants of minutes written from a transcript, checked against the team of the project
// by the code: the model writes one participant per segment of the participants slot, the name as
// the transcript writes it, and the code (never the model) reports who is not in the team. It
// never says which organization a participant belongs to: a name that is not of the team is
// «esterno al team», and the organization stays for the PM to state.

/** The text slot of the minutes that lists the participants. */
export const MINUTES_PARTICIPANTS_SLOT = 'participants'

export type MinutesTextKey = 'participants_outside_team'

/** A person of the project team, as far as the minutes need: the name. */
export interface TeamMember {
  displayName: string
}

export interface MinutesParticipants {
  /** The participants the minutes list, as written, in their order, without repeats. */
  participants: string[]
  /** Those that are not in the team of the project. */
  outsideTeam: string[]
  /** Notes for the PM only, written by the code. */
  internalNotes: string[]
}

/** The names of one segment: one participant each, or a list separated by commas or semicolons. */
function namesOf(text: string): string[] {
  return text
    .split(/[,;\n]/u)
    .map((n) => n.replace(/[\s.:]+$/u, '').trim())
    .filter((n) => n !== '')
}

/**
 * The participants of the minutes and those outside the team, with the note for the PM. The
 * names are compared in the form phrases are compared in (case, spaces and lookalike letters do
 * not count); nothing is deduced about the organization of anyone.
 */
export function minutesParticipants(
  doc: DeliverableDocument,
  team: readonly TeamMember[],
  lang: Lang,
): MinutesParticipants {
  const teamNames = new Set(team.map((m) => phraseForm(m.displayName)))
  const participants: string[] = []
  const seen = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'text' || block.id !== MINUTES_PARTICIPANTS_SLOT) continue
      for (const segment of block.segments) {
        for (const name of namesOf(segment.text)) {
          const key = phraseForm(name)
          if (seen.has(key)) continue
          seen.add(key)
          participants.push(name)
        }
      }
    }
  }
  const outsideTeam = participants.filter((p) => !teamNames.has(phraseForm(p)))
  return {
    participants,
    outsideTeam,
    internalNotes:
      outsideTeam.length === 0
        ? []
        : [
            recipeText(
              'minutes',
              'participants_outside_team',
              { names: outsideTeam.join(', ') },
              lang,
            ),
          ],
  }
}
