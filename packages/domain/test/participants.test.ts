import { describe, expect, it } from 'vitest'
import { MAX_NAMED_PARTICIPANTS, namedParticipants } from '../src/participants.ts'

const chunk = (text: string) => ({ text })

describe('namedParticipants', () => {
  it('finds who speaks in a transcript and who its roster lists, each once', () => {
    const names = namedParticipants([
      chunk('Data: 2026-11-05\nPartecipanti: Paola Prova, Luca Inventato; Maria De Rossi'),
      chunk('Paola Prova: Buongiorno a tutti.\nElena Cliente: Per noi la data è importante.'),
      chunk("Luca Inventato: decidiamo di consegnare.\nAnna D'Angelo-Bianchi: d'accordo."),
    ])
    expect(names).toEqual([
      'Paola Prova',
      'Luca Inventato',
      'Maria De Rossi',
      'Elena Cliente',
      "Anna D'Angelo-Bianchi",
    ])
  })

  it('keeps only what reads as the name of a person', () => {
    const names = namedParticipants([
      chunk('Nota: questo non è un oratore.'),
      chunk('Budget complessivo: 890.000 euro'),
      chunk('Il Gruppo: aggiornamento settimanale'),
      chunk('Presenti: il gruppo di progetto, Giulia Finta'),
      chunk('dice Marco Esempio: va bene'),
      chunk('Attendees: Roberto Ospite'),
      chunk('Paola: una parola sola non basta'),
    ])
    expect(names).toEqual(['Giulia Finta', 'Roberto Ospite'])
  })

  it('stops at its limit on a document that lists endless names', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    const word = (n: number) =>
      `${letters[Math.floor(n / 26) % 26]}${letters[n % 26]}`.replace(/^./, (c) => c.toUpperCase())
    const roster = Array.from({ length: 400 }, (_, i) => `${word(i)}rio ${word(i + 7)}ssi`)
    const names = namedParticipants([chunk(`Partecipanti: ${roster.slice(0, 250).join(', ')}`)])
    expect(names.length).toBeLessThanOrEqual(250)
    const many = namedParticipants(roster.map((name) => chunk(`${name}: parla`)))
    expect(many).toHaveLength(MAX_NAMED_PARTICIPANTS)
  })

  it('finds nothing in a text without speakers', () => {
    expect(namedParticipants([chunk('Stato avanzamento lavori\nAvanzamento: 60%')])).toEqual([])
    expect(namedParticipants([])).toEqual([])
  })
})
