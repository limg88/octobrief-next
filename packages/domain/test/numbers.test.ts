import { describe, expect, it } from 'vitest'
import {
  claimedNumberSpans,
  claimedNumbersIn,
  cutsNumber,
  dataKindsIn,
  numbersCited,
  numbersIn,
  numberText,
  onWordBoundaries,
  shownNumbersIn,
} from '../src/numbers.ts'

const IT = 'it' as const

describe('numbersIn', () => {
  it('reads Italian thousands and decimal separators as one number', () => {
    expect(numbersIn('Budget 1.200.000,50 euro, avanzamento 45,5%', IT)).toEqual([
      '1200000.5',
      '45.5',
    ])
  })

  it('reads the parts of a date as separate numbers, without leading zeros', () => {
    expect(numbersIn('consegna il 05/03/2026', IT)).toEqual(['5', '3', '2026'])
  })

  it('keeps an ambiguous dotted number as written', () => {
    expect(numbersIn('versione 1.5, ore 10.30', IT)).toEqual(['1.5', '10.30'])
  })

  it('finds no number in text without digits', () => {
    expect(numbersIn('il budget è approvato', IT)).toEqual([])
  })

  it('reads full-width digits as digits', () => {
    expect(numbersIn('rischio ３', IT)).toEqual(['3'])
  })

  it('reads the digits of any script as digits', () => {
    // Arabic-Indic and Devanagari digits.
    expect(numbersIn('rischio \u0663\u0662 e \u096a', IT)).toEqual(['32', '4'])
    expect(numbersIn('budget \u0661.\u0662\u0660\u0660', IT)).toEqual(['1200'])
  })
})

describe('numbersCited', () => {
  it('accepts a statement whose numbers all appear in a cited excerpt', () => {
    expect(numbersCited('Il budget è di 1200 euro', ['Budget approvato: 1.200 €'], IT)).toBe(true)
  })

  it('accepts a statement with no numbers', () => {
    expect(numbersCited('Il budget è approvato', [], IT)).toBe(true)
  })

  it('refuses a statement with a number that no excerpt contains', () => {
    expect(numbersCited('Avanzamento al 70%', ['Avanzamento al 60%'], IT)).toBe(false)
  })

  it('compares digits of any script with ASCII digits, in both directions', () => {
    expect(numbersCited('Avanzamento al \u0667\u0660%', ['Avanzamento al 60%'], IT)).toBe(false)
    expect(numbersCited('Avanzamento al \u0666\u0660%', ['Avanzamento al 60%'], IT)).toBe(true)
    expect(numbersCited('Avanzamento al 60%', ['Avanzamento al \uff16\uff10%'], IT)).toBe(true)
  })

  it('looks across every cited excerpt', () => {
    expect(numbersCited('3 rischi su 12 attività', ['3 rischi aperti', 'attività: 12'], IT)).toBe(
      true,
    )
  })

  it('reads numbers in words on both sides, as the check of the answers does', () => {
    expect(numbersCited('Mancano 3 settimane', ['mancano tre settimane'], IT)).toBe(true)
    expect(numbersCited('Mancano tre settimane', ['mancano 3 settimane'], IT)).toBe(true)
    expect(numbersCited('Mancano due settimane', ['mancano tre settimane'], IT)).toBe(false)
    expect(numbersCited('Durata 6 mesi', ["Se sei d'accordo, procediamo"], IT)).toBe(false)
    expect(numbersCited('Le tre priorità sono chiare', [], IT)).toBe(true)
  })
})

describe('onWordBoundaries', () => {
  const at = (text: string, excerpt: string) => {
    const start = text.indexOf(excerpt)
    return onWordBoundaries(text, start, start + excerpt.length)
  }

  it('accepts a cut between words and refuses one inside a word', () => {
    expect(at('Il fornitore è in ritardo', 'fornitore è')).toBe(true)
    expect(at('Il fornitore è in ritardo', 'ornitore è')).toBe(false)
    expect(at('Il fornitore è in ritardo', 'fornitore è in rit')).toBe(false)
  })

  it('reads letters and digits outside the basic plane as one character', () => {
    expect(at('Codice 𝐀rischio aperto', 'rischio aperto')).toBe(false)
    expect(at('Codice 𝐀 rischio aperto', 'rischio aperto')).toBe(true)
    expect(at('aperto 𝟐𝟎 lotti', 'aperto')).toBe(true)
    expect(at('aperto𝟐𝟎 lotti', 'aperto')).toBe(false)
  })

  it('refuses a cut between the two halves of one character', () => {
    const text = 'x𝐀y'
    expect(onWordBoundaries(text, 2, 4)).toBe(false)
  })
})

describe('cutsNumber', () => {
  const cut = (text: string, excerpt: string) => {
    const start = text.indexOf(excerpt)
    return cutsNumber(text, start, start + excerpt.length, IT)
  }

  it('sees an excerpt that starts after a thousands separator of a number', () => {
    expect(cut('Il budget è di 1.200.000 € in tutto', '200.000 € in tutto')).toBe(true)
  })

  it('sees an excerpt that starts inside the digits of a number', () => {
    expect(cut('Avanzamento al 15% del piano', '5% del piano')).toBe(true)
  })

  it('sees an excerpt that ends inside the digits of a number', () => {
    expect(cut('Consegna prevista nel 2026', 'Consegna prevista nel 20')).toBe(true)
  })

  it('sees an excerpt that ends on a separator followed by digits', () => {
    expect(cut('Il budget è di 1.200.000 €', 'Il budget è di 1.200.')).toBe(true)
    expect(cut('Il budget è di 1.200.000 €', 'Il budget è di 1.200')).toBe(true)
    expect(cut('Avanzamento 12,5%', 'Avanzamento 12')).toBe(true)
    expect(cut('Totale 1 200 000 €', 'Totale 1 200')).toBe(true)
  })

  it('sees a cut in digits of any script', () => {
    expect(cut('Avanzamento al \u0661\u0665% del piano', '\u0665% del piano')).toBe(true)
  })

  it('accepts an excerpt that keeps every number whole', () => {
    expect(cut('Il budget è di 1.200.000 €.', 'Il budget è di 1.200.000 €.')).toBe(false)
    expect(cut('Sezione 3. Rischi aperti: 12.', 'Rischi aperti: 12')).toBe(false)
    expect(cut('Avanzamento 62%, budget ok', 'Avanzamento 62%')).toBe(false)
    expect(cut('Stato: verde', 'Stato: verde')).toBe(false)
  })
})

describe('cutsNumber with characters outside the basic plane', () => {
  const cut = (text: string, excerpt: string) => {
    const start = text.indexOf(excerpt)
    return cutsNumber(text, start, start + excerpt.length, IT)
  }

  it('sees a cut inside a number written in mathematical digits', () => {
    expect(cut('Consegna prevista nel 𝟐𝟎𝟐𝟔', 'Consegna prevista nel 𝟐𝟎')).toBe(true)
    expect(cut('Consegna prevista nel 𝟐𝟎𝟐𝟔 ok', '𝟐𝟔 ok')).toBe(true)
    expect(cut('Totale 𝟏.𝟐𝟎𝟎 €', 'Totale 𝟏.')).toBe(true)
  })

  it('sees a cut in the middle of a digit made of two code units', () => {
    const text = 'Anno 𝟐𝟎𝟐𝟔'
    expect(cutsNumber(text, 0, text.length - 1, IT)).toBe(true)
    expect(cutsNumber(text, text.length - 1, text.length, IT)).toBe(true)
  })

  it('accepts a whole number in mathematical digits', () => {
    expect(cut('Consegna nel 𝟐𝟎𝟐𝟔.', 'Consegna nel 𝟐𝟎𝟐𝟔')).toBe(false)
    expect(cut('𝐀 Consegna nel 𝟐𝟎𝟐𝟔', 'Consegna nel 𝟐𝟎𝟐𝟔')).toBe(false)
  })
})

describe('dataKindsIn', () => {
  it('finds plain numbers', () => {
    expect(dataKindsIn('circa 3 persone', IT)).toEqual(['number'])
    expect(dataKindsIn('nessun dato qui', IT)).toEqual([])
  })

  it('finds amounts in euro', () => {
    for (const text of [
      'costo 1.200 €',
      'costo € 1.200',
      'costo 1.200,50 euro',
      'costo 12k€',
      'costo 12 k€',
      'costo 3 mila euro',
      '30 EUR',
    ]) {
      expect(dataKindsIn(text, IT), text).toContain('amount')
    }
  })

  it('finds percentages', () => {
    for (const text of ['al 45%', 'al 45 %', 'al 12,5%', 'al 30 per cento', 'al 30 percento']) {
      expect(dataKindsIn(text, IT), text).toContain('percentage')
    }
  })

  it('finds dates in Italian notations', () => {
    for (const text of [
      'entro il 05/03/2026',
      'entro il 5-3-26',
      'entro il 2026-03-05',
      'entro il 3 novembre 2026',
      'entro il 3 nov 2026',
      'entro novembre 2026',
      'entro novembre',
      'entro il 1° dicembre',
    ]) {
      expect(dataKindsIn(text, IT), text).toContain('date')
    }
    expect(dataKindsIn('entro novembre', IT)).toEqual(['date'])
    expect(dataKindsIn('il set di dati', IT)).toEqual([])
  })

  it('finds identifiers', () => {
    expect(dataKindsIn('ticket PROJ-12', IT)).toContain('identifier')
    expect(dataKindsIn('id 0f8fad5b-d9cb-469f-a165-70867728950e', IT)).toContain('identifier')
    expect(dataKindsIn('id abcdefab-abcd-abcd-abcd-abcdefabcdef', IT)).toEqual(['identifier'])
  })

  it('reads digits of other scripts', () => {
    expect(dataKindsIn('nel 𝟐𝟎𝟐𝟔 al 𝟓%', IT)).toEqual(['number', 'percentage'])
  })

  it('finds numbers written in words next to a unit or measure', () => {
    for (const text of [
      'tre settimane',
      'due milioni',
      'sei mesi',
      'cinquanta per cento',
      'metà del budget',
      'duecentocinquanta euro',
      'ventitré attività',
      'trentotto giorni',
      'tremila persone',
      'mille euro di spesa',
      'due milioni di utenti',
      'un miliardo',
      'novantanove casi',
      'servono tre nuove risorse',
      'giornate: dodici',
      'mezza giornata di lavoro',
      'un quarto delle ore',
      'un terzo dei costi',
      'dieci story point',
    ]) {
      expect(dataKindsIn(text, IT), text).toContain('number_word')
    }
  })

  it('does not read ordinary sentences as numbers in words', () => {
    for (const text of [
      'Uno dei rischi principali è il fornitore',
      "Se sei d'accordo, procediamo",
      'Le due squadre lavorano bene',
      'Il problema è a metà strada',
      'Nove volte su dieci funziona',
      'Le tre priorità sono chiare',
      'Siamo in sette nel team',
      'Le due fonti indicano date diverse',
      'una persona del team',
      'settembre e ottobre',
      'il centro di costo',
      'il treno parte',
      'un duetto',
      'il terzo fornitore',
      'novembre',
      'mezzo budget',
      'il valore è espresso per cento',
    ]) {
      expect(dataKindsIn(text, IT), text).not.toContain('number_word')
    }
  })

  it('finds a percentage written in words', () => {
    expect(dataKindsIn('al trenta per cento', IT)).toEqual(['number_word', 'percentage'])
    expect(dataKindsIn('al venti percento', IT)).toContain('percentage')
    expect(dataKindsIn('al venti %', IT)).toContain('percentage')
  })

  it('finds relative dates and weekdays', () => {
    for (const text of [
      'ieri',
      'oggi pomeriggio',
      'domani mattina',
      'dopodomani',
      'lunedì',
      'entro venerdi',
      'domenica scorsa',
      'la settimana scorsa',
      'la settimana prossima',
      'il mese scorso',
      'il trimestre scorso',
      "l'anno prossimo",
      'tra due settimane',
      'fra 3 giorni',
      'tra pochi mesi',
    ]) {
      expect(dataKindsIn(text, IT), text).toContain('date')
    }
    expect(dataKindsIn('il clima del team', IT)).toEqual([])
  })
})

describe('claimedNumbersIn and shownNumbersIn', () => {
  it('reads the value of numbers in words claimed next to a measure', () => {
    expect(claimedNumbersIn('Mancano tre settimane', IT)).toEqual(['3'])
    expect(claimedNumbersIn('duecentocinquanta euro e ventitré giorni', IT)).toEqual(['250', '23'])
    expect(claimedNumbersIn('tremila persone, duemila utenti', IT)).toEqual(['3000', '2000'])
    expect(claimedNumbersIn('due milioni di utenti', IT)).toEqual(['2'])
    expect(claimedNumbersIn('Budget 1.200 € per dieci giorni', IT)).toEqual(['1200', '10'])
    expect(claimedNumbersIn('Le tre priorità sono chiare', IT)).toEqual([])
    expect(claimedNumbersIn('un milione', IT)).toEqual([])
  })

  it('reads the numbers in words of a source by the same rule as a claim', () => {
    expect(shownNumbersIn("Se sei d'accordo, procediamo", IT)).toEqual([])
    expect(shownNumbersIn('Le due squadre lavorano bene', IT)).toEqual([])
    expect(shownNumbersIn('durata sei mesi', IT)).toEqual(['6'])
    expect(shownNumbersIn('Uno dei rischi', IT)).toEqual([])
  })

  it('reads the claimed numbers in words of a source, and every digit', () => {
    expect(shownNumbersIn('Le tre priorità e una scadenza: 3 settimane', IT)).toEqual(['3'])
    expect(shownNumbersIn('Restano tre settimane', IT)).toEqual(['3'])
    expect(shownNumbersIn('cento persone e mille euro', IT)).toEqual(['100', '1000'])
    expect(shownNumbersIn('al trenta per cento', IT)).toEqual(['30'])
    expect(shownNumbersIn('1\u200b200 euro', IT)).toEqual(['1200'])
  })
})

describe('claimedNumberSpans', () => {
  it('finds the same numbers as claimedNumbersIn, each where it is written', () => {
    for (const text of [
      'Il budget è di 1.200,50 € in tre settimane',
      'Ventitré work item e 4 story point, metà del budget',
      'Nello Sprint 12 ci sono 12 work item',
      'Nessun numero qui',
    ]) {
      const spans = claimedNumberSpans(text, 'it')
      expect([...new Set(spans.map((s) => s.value))].sort()).toEqual(
        [...claimedNumbersIn(text, 'it')].sort(),
      )
      const plain = numberText(text)
      for (const s of spans) expect(plain.slice(s.start, s.end)).not.toBe('')
    }
    const [first, second] = claimedNumberSpans('Sprint 12 con 12', 'it')
    expect([first?.start, second?.start]).toEqual([7, 14])
  })
})
