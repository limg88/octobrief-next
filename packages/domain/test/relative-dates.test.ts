import { describe, expect, it } from 'vitest'
import { FACT_KINDS, factKindDefinitions } from '../src/knowledge.ts'
import { numbersCited } from '../src/numbers.ts'
import { relativeDates, relativeTimes, withoutResolvedDates } from '../src/relative-dates.ts'
import { romeDateString, romeMidnight } from '../src/rome-time.ts'

// The meeting of the document was on Wednesday 3 June 2026.
const anchor = romeMidnight(2026, 6, 3)
const days = (text: string) => relativeDates(text, anchor, 'it').map(romeDateString).sort()

describe('relativeDates', () => {
  it('resolves today, tomorrow, the day after and yesterday', () => {
    expect(days('ne parliamo oggi')).toEqual(['2026-06-03'])
    expect(days('consegna domani')).toEqual(['2026-06-04'])
    expect(days('consegna dopodomani')).toEqual(['2026-06-05'])
    expect(days('lo abbiamo visto ieri')).toEqual(['2026-06-02'])
  })

  it('a weekday names a day only with «prossimo» or «scorso»', () => {
    // Wednesday 3 June: next Tuesday is the 9th, last Monday the 1st.
    expect(days('ci sentiamo martedì prossimo')).toEqual(['2026-06-09'])
    expect(days('il prossimo martedì')).toEqual(['2026-06-09'])
    expect(days('lunedì scorso')).toEqual(['2026-06-01'])
    // The same weekday as the meeting: a week ahead, a week back.
    expect(days('mercoledì prossimo')).toEqual(['2026-06-10'])
    expect(days('mercoledì scorso')).toEqual(['2026-05-27'])
  })

  it('a bare weekday does not accept ±7 days', () => {
    expect(days('ci sentiamo martedì')).toEqual([])
    expect(relativeTimes('ci sentiamo martedì', anchor, 'it').months).toEqual(['2026-06'])
  })

  it('the end of the month and «fra N» name a day; a week only months', () => {
    expect(days('a fine mese')).toEqual(['2026-06-30'])
    expect(days('fra 2 settimane')).toEqual(['2026-06-17'])
    expect(days('tra 10 giorni')).toEqual(['2026-06-13'])
    expect(days('entro la prossima settimana')).toEqual([])
    expect(days('nel fine settimana')).toEqual([])
    expect(relativeTimes('entro la prossima settimana', anchor, 'it').months).toEqual(['2026-06'])
  })

  it('a month without a year names the month only, in the year of the document or the next', () => {
    expect(days('il rilascio è a settembre')).toEqual([])
    // Not yet come in the year of the meeting: that year only.
    expect(relativeTimes('il rilascio è a settembre', anchor, 'it').months).toEqual(['2026-09'])
    expect(relativeTimes('a giugno', anchor, 'it').months).toEqual(['2026-06'])
    // Before the month of the meeting: past in its year, or the one after; the text tells which.
    expect(relativeTimes('entro marzo', anchor, 'it').months).toEqual(['2026-03', '2027-03'])
    expect(relativeTimes('il mese prossimo', anchor, 'it').months).toEqual(['2026-07'])
    // A month with its year is a date of the text, not a relative one.
    expect(relativeTimes('a settembre 2026', anchor, 'it').months).toEqual([])
  })

  it('says nothing for a text without a relative time', () => {
    expect(days('il collaudo è confermato')).toEqual([])
    expect(days('domanio, oggetto, ieratico')).toEqual([])
  })

  const cited = (text: string, excerpts: string[]) =>
    numbersCited(withoutResolvedDates(text, excerpts, anchor, 'it'), excerpts, 'it')

  it('a resolved relative date is accepted as a whole date', () => {
    const excerpts = ['Marco consegna il documento domani.']
    expect(cited('Consegna entro il 4 giugno 2026', excerpts)).toBe(true)
    expect(cited('Consegna entro il 1° giugno 2026', ['ne parliamo lunedì scorso'])).toBe(true)
    expect(cited('Consegna entro il 2026-06-04', excerpts)).toBe(true)
    expect(cited('Consegna entro il 4/6/2026', excerpts)).toBe(true)
    expect(cited('Consegna entro il 04.06.2026', excerpts)).toBe(true)
    // An invented year, or a day the excerpt does not name, is not a resolved date.
    expect(cited('Consegna entro il 4 giugno 2025', excerpts)).toBe(false)
    expect(cited('Consegna entro il 5 giugno 2026', excerpts)).toBe(false)
    // Without a relative time in the excerpts nothing is resolved.
    expect(cited('Consegna entro il 4 giugno 2026', ['Marco consegna il documento.'])).toBe(false)
  })

  it('a number from a derived date does not pass as cited elsewhere', () => {
    const excerpts = ['Marco consegna il documento domani.']
    // 4, 6 and 2026 are numbers of the resolved day, never numbers of anything else.
    expect(cited('Servono 4 persone', excerpts)).toBe(false)
    expect(cited('Il budget è di 2026 euro', excerpts)).toBe(false)
    expect(cited('Consegna entro il 4 giugno 2026 con 6 moduli', excerpts)).toBe(false)
    expect(cited('Consegna il 4 giugno 2026 di 6 moduli', [...excerpts, 'sono 6 moduli'])).toBe(
      true,
    )
  })

  it('a month named without a year is accepted as month and year, never as a day', () => {
    const excerpts = ['Il rilascio è a settembre.']
    expect(cited('Rilascio a settembre 2026', excerpts)).toBe(true)
    // A day guessed from «a settembre» has no source.
    expect(cited('Rilascio il 15 settembre 2026', excerpts)).toBe(false)
    expect(cited('Rilascio il 1 settembre 2026', excerpts)).toBe(false)
    expect(cited('Rilascio il 30/9/2026', excerpts)).toBe(false)
    // A month still ahead in the year of the document: never the next year.
    expect(cited('Rilascio a settembre 2027', excerpts)).toBe(false)
    expect(cited('Rilascio a settembre 2025', excerpts)).toBe(false)
    expect(cited('Rilascio a settembre 2028', excerpts)).toBe(false)
  })

  it('a month in the past resolves to the year of the evidence', () => {
    // A document of June 2026 tells of March.
    const excerpts = ['A marzo abbiamo consegnato il primo rilascio.']
    expect(cited('Primo rilascio consegnato a marzo 2026', excerpts)).toBe(true)
    // The March after is a candidate too, as a month only.
    expect(cited('Primo rilascio consegnato a marzo 2027', excerpts)).toBe(true)
    // Never a day, never another year.
    expect(cited('Primo rilascio consegnato il 15 marzo 2026', excerpts)).toBe(false)
    expect(cited('Primo rilascio consegnato il 31/3/2026', excerpts)).toBe(false)
    expect(cited('Primo rilascio consegnato il 2026-03-01', excerpts)).toBe(false)
    expect(cited('Primo rilascio consegnato a marzo 2025', excerpts)).toBe(false)
  })

  it('a bare weekday never lets a day through', () => {
    const excerpts = ['Ci sentiamo martedì.']
    for (const day of ['2 giugno 2026', '9 giugno 2026', '16 giugno 2026']) {
      expect(cited(`Riunione il ${day}`, excerpts)).toBe(false)
    }
    expect(cited('Riunione a giugno 2026', excerpts)).toBe(true)
  })

  it('a date written in an excerpt stays a date of the text', () => {
    const excerpts = ['Il collaudo è il 12 giugno 2026, domani si prepara.']
    expect(cited('Collaudo il 12 giugno 2026', excerpts)).toBe(true)
    expect(cited('Collaudo il 2026-06-12', excerpts)).toBe(false)
  })
})

describe('factKindDefinitions', () => {
  it('defines every kind of fact', () => {
    const definitions = factKindDefinitions('it')
    for (const kind of FACT_KINDS) expect(definitions[kind].length).toBeGreaterThan(10)
  })

  it('a proposal is not a decision and an action says who and by when', () => {
    const definitions = factKindDefinitions('it')
    expect(definitions.decision).toMatch(/presa o concordata/)
    expect(definitions.decision).toMatch(/proposta.*non sono decisioni/)
    expect(definitions.action).toMatch(/chi la fa ed entro quando/)
    expect(definitions.action).toMatch(/value è la scadenza/)
  })
})
