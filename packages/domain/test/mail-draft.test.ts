import { describe, expect, it } from 'vitest'
import {
  type AvailableActions,
  availableActions,
  type ClientDocument,
  type InternalDocument,
  mailCopy,
  parseRecipients,
  type RevisionFacts,
} from '../src/recipe/index.ts'
import { INTERNAL_NOTE } from './support/client-version.ts'
import { mailParameters } from './support/mail-recipe.ts'

// The client mail as a draft to copy: the sections «subject» and «body» of the client version,
// never the internal notes, only after the approval, and the recipients checked by the code
// against the team of the project.

const FACTS: RevisionFacts = {
  state: 'in_review',
  n: 1,
  blockers: [],
  acceptable: 0,
  decidable: 0,
  confirmable: 0,
  textSlots: 1,
  snapshotTooOld: false,
}

const actions = (state: RevisionFacts['state']): AvailableActions =>
  availableActions({ ...FACTS, state }, { role: 'pm' })

const cell = (text: string) => ({
  text,
  category: 'other' as const,
  operandCategories: ['other' as const],
  sources: [1],
})

function clientMail(): ClientDocument {
  return {
    schema: 'octobrief.document/1',
    recipe: { slug: 'mail-cliente', version: '1.0.0', title: 'Mail al cliente' },
    audience: 'client',
    lang: 'it',
    title: 'Mail al cliente',
    header: { dataAsOf: '2026-11-05T07:00:00.000Z', generatedAt: '2026-11-06T09:30:00.000Z' },
    sections: [
      {
        id: 'subject',
        title: 'Oggetto',
        version: 'both',
        notDeduced: false,
        blocks: [{ kind: 'static', id: 'subject_line', text: 'Aggiornamento sul progetto Apollo' }],
      },
      {
        id: 'body',
        title: 'Testo',
        version: 'both',
        notDeduced: false,
        blocks: [
          { kind: 'static', id: 'greeting', text: 'Buongiorno,' },
          {
            kind: 'text',
            id: 'status',
            notDeduced: false,
            segments: [
              {
                text: 'Sono stati fatturati 8.000,00 € sui 12.000,00 € dell’ordine.',
                nature: 'fact',
                category: 'invoiced_amounts',
                sources: [1],
                sourceCategories: ['invoiced_amounts'],
              },
            ],
          },
          {
            kind: 'table',
            id: 'positions',
            columns: [
              { id: 'item', title: 'Voce', category: 'other' },
              { id: 'state', title: 'Stato', category: 'other' },
            ],
            notDeduced: false,
            rows: [{ key: '1', cells: [cell('Analisi'), cell('Chiusa')] }],
          },
          { kind: 'static', id: 'closing', text: 'Cordiali saluti' },
        ],
      },
      {
        id: 'attachments',
        title: 'Allegati',
        version: 'both',
        notDeduced: false,
        blocks: [{ kind: 'static', id: 'other', text: 'Una sezione che non è della mail.' }],
      },
    ],
    sourceNotes: [
      {
        n: 1,
        label: 'Sistema amministrativo, dati al 05/11/2026',
        dataAsOf: '2026-11-05T07:00:00.000Z',
      },
    ],
    internalNotes: [],
  }
}

function internalNotes(): InternalDocument['internalNotes'] {
  return [
    {
      text: INTERNAL_NOTE,
      nature: 'fact',
      category: 'other',
      sources: [],
      sourceCategories: [],
    },
  ]
}

const TEAM = [
  { displayName: 'Anna Rossi', email: 'anna.rossi@example.test' },
  { displayName: 'Luca Bianchi', email: 'Luca.Bianchi@Example.test' },
  { displayName: 'Senza posta', email: null },
]

const input = (
  over: Partial<Parameters<typeof mailCopy>[0]> = {},
): Parameters<typeof mailCopy>[0] => ({
  actions: actions('approved'),
  client: clientMail(),
  internalNotes: internalNotes(),
  parameters: {},
  team: TEAM,
  lang: 'it',
  ...over,
})

function ok(result: ReturnType<typeof mailCopy>) {
  if (!result.ok) throw new Error(`no copy: ${result.reason}`)
  return result.mail
}

describe('the client mail as a draft to copy', () => {
  it('copies only client sections after approval', () => {
    const mail = ok(mailCopy(input()))
    expect(mail.subject).toBe('Aggiornamento sul progetto Apollo')
    expect(mail.copyText).toContain('Buongiorno,')
    expect(mail.copyText).toContain('Sono stati fatturati 8.000,00 €')
    expect(mail.copyText).toContain('Cordiali saluti')
    // Neither the internal notes nor a section that is not the subject or the body.
    expect(mail.copyText).not.toContain(INTERNAL_NOTE)
    expect(mail.markdown).not.toContain(INTERNAL_NOTE)
    expect(mail.copyText).not.toContain('Una sezione che non è della mail.')
    expect(mail.markdown).not.toContain('Una sezione che non è della mail.')
    // The internal notes are shown apart.
    expect(mail.internalNotes).toContain(INTERNAL_NOTE)
  })

  it('keeps with a figure of the copied text its source note and the date of the data', () => {
    const mail = ok(mailCopy(input()))
    // The figure carries the number of its note; the note and the date follow the body.
    expect(mail.copyText).toContain(
      'Sono stati fatturati 8.000,00 € sui 12.000,00 € dell’ordine. [1]',
    )
    expect(mail.copyText).toContain('[1] Sistema amministrativo, dati al 05/11/2026')
    expect(mail.copyText).toContain('Dati al 05/11/2026, generato il 06/11/2026')
    expect(mail.copyText.indexOf('Cordiali saluti')).toBeLessThan(mail.copyText.indexOf('Fonti'))
    // A cell of a table carries its note too.
    expect(mail.copyText).toContain('Analisi [1] | Chiusa [1]')
  })

  it('also copies after approval with accepted anomalies', () => {
    expect(mailCopy(input({ actions: actions('approved_with_accepted_anomalies') })).ok).toBe(true)
  })

  it('offers no copy before approval', () => {
    for (const state of [
      'in_preparation',
      'in_review',
      'approving',
      'render_failed',
      'superseded',
      'failed',
      'discarded',
    ] as const) {
      const result = mailCopy(input({ actions: actions(state) }))
      expect(result, state).toEqual({ ok: false, reason: 'not_approved' })
    }
  })

  it('offers no copy to someone outside the project', () => {
    const result = mailCopy(
      input({ actions: availableActions({ ...FACTS, state: 'approved' }, { role: null }) }),
    )
    expect(result).toEqual({ ok: false, reason: 'not_project_member' })
  })

  it('offers no copy when the recipe has no client version or no mail sections', () => {
    expect(mailCopy(input({ client: null }))).toEqual({ ok: false, reason: 'not_a_mail' })
    const doc = clientMail()
    doc.sections = doc.sections.filter((s) => s.id !== 'subject')
    expect(mailCopy(input({ client: doc }))).toEqual({ ok: false, reason: 'not_a_mail' })
  })

  it('writes the Markdown with the subject, the body, the sources and the date of the data', () => {
    const md = ok(mailCopy(input())).markdown
    expect(md).toContain('**Oggetto:** Aggiornamento sul progetto Apollo')
    expect(md).toContain('| Voce | Stato |')
    expect(md).toContain('| Analisi [1] | Chiusa [1] |')
    expect(md).toContain('[1]')
    expect(md).toContain('Sistema amministrativo, dati al 05/11/2026')
    expect(md).toContain('Dati al 05/11/2026')
  })

  it('writes «non dedotto» for a section the PM left without its data', () => {
    const doc = clientMail()
    const body = doc.sections.find((s) => s.id === 'body')
    if (!body) throw new Error('no body')
    body.notDeduced = true
    expect(ok(mailCopy(input({ client: doc }))).copyText).toContain('non dedotto')
  })
})

describe('the recipients of the mail', () => {
  it('come from the team of the project when no parameter names them', () => {
    const mail = ok(mailCopy(input()))
    expect(mail.recipients).toEqual(['anna.rossi@example.test', 'luca.bianchi@example.test'])
    expect(mail.internalNotes).toEqual([INTERNAL_NOTE])
  })

  it('come from the parameter, and those outside the team are reported in the internal notes', () => {
    const mail = ok(
      mailCopy(
        input({
          parameters: mailParameters(
            'Anna.Rossi@example.test; cliente@client.example , cliente@client.example',
          ),
        }),
      ),
    )
    expect(mail.recipients).toEqual(['anna.rossi@example.test', 'cliente@client.example'])
    expect(mail.outsideTeam).toEqual(['cliente@client.example'])
    expect(mail.internalNotes.some((n) => n.includes('cliente@client.example'))).toBe(true)
    // The warning is for the PM, never in what is copied.
    expect(mail.copyText).not.toContain('cliente@client.example')
    expect(mail.markdown).not.toContain('cliente@client.example')
  })

  it('reports an address that is not one, and keeps it out of the recipients', () => {
    const mail = ok(
      mailCopy(input({ parameters: mailParameters('anna.rossi@example.test, non-un-indirizzo') })),
    )
    expect(mail.recipients).toEqual(['anna.rossi@example.test'])
    expect(mail.internalNotes.some((n) => n.includes('non-un-indirizzo'))).toBe(true)
  })

  it('reads only the typed text a run stores, never a bare string', () => {
    const mail = ok(mailCopy(input({ parameters: { recipients: 'cliente@client.example' } })))
    expect(mail.outsideTeam).toEqual([])
    expect(mail.recipients).toEqual(['anna.rossi@example.test', 'luca.bianchi@example.test'])
  })

  it('reports nobody outside the team when every address is of the team', () => {
    const mail = ok(mailCopy(input({ parameters: mailParameters('luca.bianchi@example.test') })))
    expect(mail.outsideTeam).toEqual([])
    expect(mail.internalNotes).toEqual([INTERNAL_NOTE])
  })
})

describe('parseRecipients', () => {
  it('splits on commas, semicolons and spaces, lowers the case and drops repeats', () => {
    expect(parseRecipients('A@x.example;b@x.example  a@x.example,\nc@x.example')).toEqual({
      valid: ['a@x.example', 'b@x.example', 'c@x.example'],
      invalid: [],
    })
  })

  it('takes nothing from what is not text', () => {
    expect(parseRecipients(undefined)).toEqual({ valid: [], invalid: [] })
    expect(parseRecipients(42)).toEqual({ valid: [], invalid: [] })
  })

  it('refuses a name with an address inside, so a display name never passes for one', () => {
    expect(parseRecipients('<a@x.example>').invalid).toEqual(['<a@x.example>'])
  })
})
