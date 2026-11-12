import { describe, expect, it } from 'vitest'
import {
  ANOMALY_ACCEPTABILITY,
  acceptAnomaly,
  acceptanceRefusalText,
  CLIENT_SOURCE_CLASSES,
  clientPolicy,
  clientSourceClass,
  clientSourceNoteLabel,
  clientTreatment,
  DATA_CATEGORIES,
  hasForeignLetters,
  internalTermsIn,
  isAcceptableCode,
  isAcceptanceReason,
  isAccepted,
  isClientSourceNoteLabel,
  recipeDictionary,
} from '../src/recipe/index.ts'
import { growthSlope, HANG_GUARD_MS, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

describe('client source note', () => {
  it('names the generic class of the source and the day of its data in Italy', () => {
    const late = '2026-11-05T23:30:00.000Z' // already the 6th in Rome
    expect(
      clientSourceNoteLabel(
        clientSourceClass({
          kind: 'system_row',
          sourceId: 'd',
          view: 'v',
          key: [{ column: 'a', value: '1' }],
        }),
        late,
        'it',
      ),
    ).toBe('Sistema amministrativo, dati al 06/11/2026')
    expect(
      clientSourceNoteLabel(
        clientSourceClass({ kind: 'work_item_counts', sourceId: 'a', query: 'q' }),
        late,
        'it',
      ),
    ).toBe('Backlog di progetto, aggiornato al 06/11/2026')
    expect(
      clientSourceNoteLabel(
        clientSourceClass({
          kind: 'evidence',
          evidenceId: 'e',
          locator: { kind: 'page', page: 1 },
        }),
        null,
        'it',
      ),
    ).toBe('Documento di progetto, data non indicata')
    expect(clientSourceClass({ kind: 'fact', factId: 'f' })).toBe('project_knowledge')
    expect(clientSourceClass({ kind: 'parameter', parameterId: 'p' })).toBe('pm')
  })

  it('has a dated and an undated text for every class, without placeholders left', () => {
    for (const c of CLIENT_SOURCE_CLASSES) {
      for (const at of ['2026-01-02T10:00:00.000Z', null]) {
        const label = clientSourceNoteLabel(c, at, 'it')
        expect(label).not.toMatch(/[{}]/)
        expect(isClientSourceNoteLabel(label, at, 'it')).toBe(true)
      }
    }
    expect(isClientSourceNoteLabel('Estrazione economica DWSI', null, 'it')).toBe(false)
    expect(
      isClientSourceNoteLabel(
        'Sistema amministrativo, dati al 05/11/2026',
        '2026-11-06T10:00:00.000Z',
        'it',
      ),
    ).toBe(false)
  })
})

describe('internal lexicon', () => {
  it('finds whole words of the organization, once each, the longest at a place', () => {
    expect(internalTermsIn('Il costo orario sale; il costo totale no.', 'it')).toEqual([
      { category: 'costs', term: 'costo' },
      { category: 'rates', term: 'costo orario' },
    ])
    expect(internalTermsIn('Il costo orario sale.', 'it')).toEqual([
      { category: 'rates', term: 'costo orario' },
    ])
    expect(internalTermsIn('MARGINALITÀ al 20%, 12 giornate   stimate', 'it')).toEqual([
      { category: 'margins', term: 'marginalità' },
      { category: 'estimates', term: 'giornate stimate' },
    ])
    expect(internalTermsIn('Chiusi 30 story points e 120 ore lavorate.', 'it')).toEqual([
      { category: 'hours', term: 'ore lavorate' },
      { category: 'story_points', term: 'story points' },
    ])
  })

  it('reads dashes, spaces around separators and lookalike letters as the same word', () => {
    const cases: Array<[string, string]> = [
      ['gg / uomo', 'estimates'],
      ['giorni\u2013uomo', 'estimates'],
      ['giorni - uomo', 'estimates'],
      ['daily-rate', 'rates'],
      ['FTEs', 'estimates'],
      ['efforts', 'estimates'],
      ['rates', 'rates'],
      ['\u0421\u041e\u0405\u0422\u041e', 'costs'],
      ['\u0441\u043e\u0455\u0442\u043e', 'costs'],
      ['c\u0585sto', 'costs'],
      ['c\u200b\u043e\u200bsto', 'costs'],
    ]
    for (const [text, category] of cases) {
      expect(internalTermsIn(text, 'it').map((h) => h.category)).toEqual([category])
    }
  })

  it(
    'grows linearly with a text full of internal terms',
    () => {
      const unit = 'соѕто orario, costo, margine; '
      const text = unit.repeat(Math.ceil(256_000 / unit.length))
      expect(internalTermsIn(text, 'it').map((h) => h.term)).toEqual([
        'costo',
        'costo orario',
        'margine',
      ])
      const { slope, largeMs } = growthSlope((fraction) => {
        const part = text.slice(0, Math.round(text.length * fraction))
        return () => internalTermsIn(part, 'it')
      })
      expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
      expect(largeMs).toBeLessThan(HANG_GUARD_MS)
    },
    TIMING_TEST_TIMEOUT_MS,
  )

  it('reads the micro and ohm signs as units, not as Greek letters', () => {
    expect(hasForeignLetters('Latenza media 5 µs.', 'it')).toBe(false)
    expect(hasForeignLetters('Resistenza da 10 Ω.', 'it')).toBe(false)
    expect(hasForeignLetters('Latenza media 5 μs.', 'it')).toBe(true)
  })

  it('treats a micro sign inside a word as a lookalike, not as a unit', () => {
    expect(hasForeignLetters('Servono 12 giorni-µomo.', 'it')).toBe(true)
    expect(internalTermsIn('Servono 12 giorni-µomo.', 'it').length).toBeGreaterThan(0)
  })

  it('finds letters that do not belong in an Italian text', () => {
    expect(hasForeignLetters('Il c\u200b\u043e\u200bsto resta.', 'it')).toBe(true)
    expect(hasForeignLetters('\u0421\u041e\u0405\u0422\u041e', 'it')).toBe(true)
    expect(hasForeignLetters('Riunione con \u039d\u03af\u03ba\u03bf\u03c2.', 'it')).toBe(true)
    expect(hasForeignLetters('Perché è già così: 5 €, 20%.', 'it')).toBe(false)
  })

  it('knows the other words of the organization for internal economics and effort', () => {
    const cases: Array<[string, string]> = [
      ['giorni-uomo', 'estimates'],
      ['gg/uomo', 'estimates'],
      ['ore uomo', 'estimates'],
      ['giornata uomo', 'estimates'],
      ['effort', 'estimates'],
      ['FTE', 'estimates'],
      ['costano troppo', 'costs'],
      ['cost', 'costs'],
      ['prezzo interno', 'rates'],
      ['daily rate', 'rates'],
      ['ricarico', 'margins'],
      ['margin', 'margins'],
      ['mar\u00adgine', 'margins'],
    ]
    for (const [text, category] of cases) {
      expect(internalTermsIn(text, 'it').map((h) => h.category)).toEqual([category])
    }
  })

  it('does not find a term inside another word, nor in an empty text', () => {
    expect(internalTermsIn('Questo costituisce la tariffazione', 'it')).toEqual([])
    expect(internalTermsIn('   ', 'it')).toEqual([])
  })
})

describe('client policy', () => {
  it('treats story points apart, and everything outside the list as internal', () => {
    const policy = clientPolicy()
    expect(clientTreatment(policy, 'story_points')).toBe('story_points')
    expect(clientTreatment(policy, 'invoiced_amounts')).toBe('allowed')
    for (const c of DATA_CATEGORIES) {
      if (['contract_amounts', 'invoiced_amounts', 'other', 'story_points'].includes(c)) continue
      expect(clientTreatment(policy, c)).toBe('internal')
    }
    expect(clientPolicy([]).allowed).toEqual([])
    expect(Object.isFrozen(policy.allowed)).toBe(true)
    // A policy object not made by clientPolicy cannot widen anything.
    const forged = { allowed: ['costs', 'margins', 'other'] } as unknown as typeof policy
    expect(clientTreatment(forged, 'costs')).toBe('internal')
    expect(clientTreatment(forged, 'other')).toBe('allowed')
  })
})

describe('accept as is', () => {
  const anomaly = { code: 'internal_data_in_client', refKey: '{"a":1}', contentHash: 'sha256:aa' }
  const reason = 'Il cliente conosce già questo importo.'

  it('binds an acceptance to the code, the place and the content', () => {
    const r = acceptAnomaly(anomaly, { reason: `  ${reason}  `, by: 'pm-1', at: 'now' })
    if (!r.ok) throw new Error('expected an acceptance')
    expect(r.acceptance).toEqual({ ...anomaly, reason, by: 'pm-1', at: 'now' })
    expect(isAccepted(anomaly, [r.acceptance])).toBe(true)
    expect(isAccepted({ ...anomaly, contentHash: 'sha256:bb' }, [r.acceptance])).toBe(false)
    expect(isAccepted({ ...anomaly, refKey: '{"a":2}' }, [r.acceptance])).toBe(false)
    expect(isAccepted(anomaly, [{ ...r.acceptance, reason: 'troppo corta' }])).toBe(false)
    // A stored acceptance of a code nobody may accept never applies.
    const forged = { ...r.acceptance, code: 'credential_in_text' }
    expect(isAccepted({ ...anomaly, code: 'credential_in_text' }, [forged])).toBe(false)
  })

  it('refuses a reason without enough letters as the PM sees them', () => {
    const tricks = [
      '\u200b'.repeat(25),
      'a\u0301'.repeat(15),
      '😀'.repeat(25),
      '.'.repeat(25),
      ' '.repeat(30),
      '1234567890 1234567890 12',
    ]
    for (const reason of tricks) {
      expect(acceptAnomaly(anomaly, { reason, by: 'pm', at: 'now' })).toEqual({
        ok: false,
        refusal: 'reason_too_short',
      })
    }
    expect(isAcceptanceReason(reason)).toBe(true)
  })

  it('refuses unknown codes and those the code itself guarantees', () => {
    expect(isAcceptableCode('something_new')).toBe(false)
    expect(isAcceptableCode('toString')).toBe(false)
    for (const [code, acceptable] of Object.entries(ANOMALY_ACCEPTABILITY)) {
      expect(isAcceptableCode(code)).toBe(acceptable)
    }
    expect(acceptanceRefusalText('reason_too_short', 'it')).toContain('20')
  })

  it('has a text for every category name the PM reads', () => {
    for (const c of DATA_CATEGORIES) expect(recipeDictionary('it').categories[c]).toBeTruthy()
  })
})
