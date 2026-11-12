import { describe, expect, it } from 'vitest'
import { ANSWER_LIMITS, modelAnswerSchema, parseModelAnswer } from '../src/index.ts'

const valid = () => ({
  lang: 'it',
  segments: [
    {
      text: 'Il budget è di 1.200 €',
      nature: 'fact',
      sources: [{ evidenceId: 'e1', locator: { kind: 'page', page: 2 } }, { factId: 'f1' }],
    },
  ],
  contradictions: [
    {
      subject: 'Budget',
      reason: 'Due valori',
      sides: [
        { value: '1.200 €', source: { factId: 'f1' } },
        {
          value: '1.500 €',
          source: { evidenceId: 'e2', locator: { kind: 'cell', sheet: 'B', ref: 'C3' } },
        },
      ],
    },
  ],
  absences: [{ question: 'Chi approva il piano?', proposal: 'Chiedilo allo sponsor' }],
})

type Valid = ReturnType<typeof valid>

const errorOf = (value: unknown) => {
  const result = parseModelAnswer(value)
  return 'error' in result ? result.error : null
}

describe('parseModelAnswer', () => {
  it('accepts a well-formed answer', () => {
    expect(parseModelAnswer(valid())).toEqual(valid())
  })

  it('drops any field outside the contract, such as a date or a freshness from the model', () => {
    const raw = valid() as Record<string, unknown>
    raw.freshness = 'fresh'
    const seg = (raw.segments as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    seg.sourceDate = '2026-11-05'
    ;(seg.sources as Array<Record<string, unknown>>)[0] = {
      evidenceId: 'e1',
      locator: { kind: 'page', page: 2, note: 'x' },
      title: 'Inventato',
      sourceDate: '2026-11-05',
    }
    expect(parseModelAnswer(raw)).toEqual(valid())
  })

  it('canonicalizes every text of the model and checks blankness on the canonical form', () => {
    const raw = valid()
    ;(raw.segments[0] as { text: string }).text = '  Mario\u200bRossi  ha\u00a0 speso €\u200b5 '
    ;(raw.contradictions[0] as { subject: string }).subject = 'AC\u00adME'
    ;(raw.contradictions[0]?.sides[0] as { value: string }).value = '1\u200b200'
    ;(raw.contradictions[0] as { reason: string }).reason = 'nov\u200bembre'
    ;(raw.absences[0] as { question: string }).question = 'Chi\u200b approva?'
    ;(raw.absences[0] as { proposal: string }).proposal = '\ufeffChiedi'
    const parsed = parseModelAnswer(raw)
    if ('error' in parsed) throw new Error('expected a valid answer')
    expect(parsed.segments[0]?.text).toBe('MarioRossi ha speso €5')
    expect(parsed.contradictions[0]?.subject).toBe('ACME')
    expect(parsed.contradictions[0]?.sides[0]?.value).toBe('1200')
    expect(parsed.contradictions[0]?.reason).toBe('novembre')
    expect(parsed.absences[0]).toEqual({ question: 'Chi approva?', proposal: 'Chiedi' })

    const invisible = valid()
    ;(invisible.segments[0] as { text: string }).text = '\u200b'
    expect(errorOf(invisible)).toEqual({ path: 'segments.0.text', problem: 'invalid' })
  })

  it('marks the fields holding a word that mixes Latin with Cyrillic or Greek letters', () => {
    const raw = valid()
    ;(raw.segments[0] as { text: string }).text = 'Ne parla M\u0430rio Rossi'
    ;(raw.absences[0] as { proposal: string }).proposal = 'Chiedi a \u03b1lberto'
    const parsed = parseModelAnswer(raw)
    if ('error' in parsed) throw new Error('expected a valid answer')
    expect(parsed.mixedScript).toEqual(['segments.0.text', 'absences.0.proposal'])
    const plain = parseModelAnswer(valid())
    expect('error' in plain ? null : plain.mixedScript).toBeUndefined()
  })

  it('requires the language', () => {
    const raw = valid() as Record<string, unknown>
    delete raw.lang
    expect(errorOf(raw)).toEqual({ path: 'lang', problem: 'invalid' })
    expect(errorOf({ ...valid(), lang: 'en' })).toEqual({ path: 'lang', problem: 'invalid' })
  })

  it('refuses something that is not an object', () => {
    expect(errorOf(null)).toEqual({ path: '', problem: 'invalid' })
    expect(errorOf('testo')).toEqual({ path: '', problem: 'invalid' })
    expect(errorOf({ ...valid(), segments: 'x' })).toEqual({ path: 'segments', problem: 'invalid' })
  })

  it('refuses a source with both forms, or with neither', () => {
    const both = valid()
    ;(both.segments[0]?.sources as unknown[])[0] = {
      evidenceId: 'e1',
      locator: { kind: 'page', page: 1 },
      factId: 'f1',
    }
    expect(errorOf(both)).toEqual({ path: 'segments.0.sources.0', problem: 'invalid' })
    const neither = valid()
    ;(neither.segments[0]?.sources as unknown[])[0] = {}
    expect(errorOf(neither)).toEqual({ path: 'segments.0.sources.0', problem: 'invalid' })
    const noLocator = valid()
    ;(noLocator.segments[0]?.sources as unknown[])[0] = { evidenceId: 'e1' }
    expect(errorOf(noLocator)).toEqual({ path: 'segments.0.sources.0', problem: 'invalid' })
    const badLocator = valid()
    ;(badLocator.segments[0]?.sources as unknown[])[0] = {
      evidenceId: 'e1',
      locator: { kind: 'page', page: 0 },
    }
    expect(errorOf(badLocator)).toEqual({
      path: 'segments.0.sources.0.locator',
      problem: 'invalid',
    })
  })

  it('accepts every kind of locator, keeping only its own fields', () => {
    const locators = [
      { kind: 'paragraph', index: 4 },
      { kind: 'slide', slide: 2 },
      { kind: 'line', from: 3, to: 9 },
    ]
    const raw = valid()
    ;(raw.segments[0] as { sources: unknown[] }).sources = locators.map((locator) => ({
      evidenceId: 'e1',
      locator: { ...locator, page: 7 },
    }))
    const parsed = parseModelAnswer(raw)
    expect('error' in parsed ? null : parsed.segments[0]?.sources).toEqual(
      locators.map((locator) => ({ evidenceId: 'e1', locator })),
    )
    const backwards = valid()
    ;(backwards.segments[0] as { sources: unknown[] }).sources = [
      { evidenceId: 'e1', locator: { kind: 'line', from: 9, to: 3 } },
    ]
    expect(errorOf(backwards)).toEqual({
      path: 'segments.0.sources.0.locator',
      problem: 'invalid',
    })
  })

  it('refuses an unknown nature and an empty or blank text', () => {
    const nature = valid()
    ;(nature.segments[0] as { nature: string }).nature = 'opinion'
    expect(errorOf(nature)).toEqual({ path: 'segments.0.nature', problem: 'invalid' })
    const blank = valid()
    ;(blank.segments[0] as { text: string }).text = '   '
    expect(errorOf(blank)).toEqual({ path: 'segments.0.text', problem: 'invalid' })
  })

  it('enforces the limits of the contract', () => {
    const long = valid()
    ;(long.segments[0] as { text: string }).text = 'a'.repeat(ANSWER_LIMITS.textMax + 1)
    expect(errorOf(long)).toEqual({ path: 'segments.0.text', problem: 'too_long' })

    const exact = valid()
    // Characters, not code units: an astral character counts once.
    ;(exact.segments[0] as { text: string }).text = '𝟐'.repeat(ANSWER_LIMITS.textMax)
    expect('error' in parseModelAnswer(exact)).toBe(false)

    const segs = valid()
    segs.segments = Array.from(
      { length: ANSWER_LIMITS.segmentsMax + 1 },
      () => valid().segments[0] as Valid['segments'][number],
    )
    expect(errorOf(segs)).toEqual({ path: 'segments', problem: 'too_many' })

    const sources = valid()
    ;(sources.segments[0] as { sources: unknown[] }).sources = Array.from(
      { length: ANSWER_LIMITS.sourcesPerSegmentMax + 1 },
      () => ({ factId: 'f1' }),
    )
    expect(errorOf(sources)).toEqual({ path: 'segments.0.sources', problem: 'too_many' })

    const oneSide = valid()
    oneSide.contradictions[0]?.sides.pop()
    expect(errorOf(oneSide)).toEqual({ path: 'contradictions.0.sides', problem: 'too_few' })

    const sixSides = valid()
    ;(sixSides.contradictions[0] as { sides: unknown[] }).sides = Array.from({ length: 6 }, () => ({
      value: 'x',
      source: { factId: 'f1' },
    }))
    expect(errorOf(sixSides)).toEqual({ path: 'contradictions.0.sides', problem: 'too_many' })

    const contradictions = valid()
    contradictions.contradictions = Array.from(
      { length: ANSWER_LIMITS.contradictionsMax + 1 },
      () => valid().contradictions[0] as Valid['contradictions'][number],
    )
    expect(errorOf(contradictions)).toEqual({ path: 'contradictions', problem: 'too_many' })

    const absences = valid()
    absences.absences = Array.from(
      { length: ANSWER_LIMITS.absencesMax + 1 },
      () => valid().absences[0] as Valid['absences'][number],
    )
    expect(errorOf(absences)).toEqual({ path: 'absences', problem: 'too_many' })

    const id = valid()
    ;(id.segments[0] as { sources: unknown[] }).sources = [{ factId: 'f'.repeat(101) }]
    expect(errorOf(id)).toEqual({ path: 'segments.0.sources.0.factId', problem: 'too_long' })
  })

  it('checks every text of contradictions and absences', () => {
    const subject = valid()
    ;(subject.contradictions[0] as { subject: unknown }).subject = 3
    expect(errorOf(subject)).toEqual({ path: 'contradictions.0.subject', problem: 'invalid' })
    const value = valid()
    ;(value.contradictions[0]?.sides[0] as { value: string }).value = ''
    expect(errorOf(value)).toEqual({ path: 'contradictions.0.sides.0.value', problem: 'invalid' })
    const side = valid()
    ;(side.contradictions[0]?.sides as unknown[])[1] = 'x'
    expect(errorOf(side)).toEqual({ path: 'contradictions.0.sides.1', problem: 'invalid' })
    const proposal = valid()
    ;(proposal.absences[0] as { proposal: string }).proposal = 'p'.repeat(
      ANSWER_LIMITS.shortTextMax + 1,
    )
    expect(errorOf(proposal)).toEqual({ path: 'absences.0.proposal', problem: 'too_long' })
  })
})

describe('parseModelAnswer enforces what the schema sent to the model no longer says', () => {
  const withSource = (src: unknown) => {
    const a = valid()
    ;(a.segments[0] as { sources: unknown[] }).sources = [src]
    return a
  }

  it('a blank or empty id is refused (was pattern and minLength)', () => {
    expect(errorOf(withSource({ factId: '   ' }))).toEqual({
      path: 'segments.0.sources.0.factId',
      problem: 'invalid',
    })
    expect(errorOf(withSource({ evidenceId: '', locator: { kind: 'page', page: 1 } }))).toEqual({
      path: 'segments.0.sources.0.evidenceId',
      problem: 'invalid',
    })
  })

  it('a cell reference out of the A1 form is refused (was pattern)', () => {
    for (const ref of ['c3', 'C0', '3C', 'C03', '']) {
      expect(
        errorOf(withSource({ evidenceId: 'e1', locator: { kind: 'cell', sheet: 'B', ref } })),
      ).toEqual({ path: 'segments.0.sources.0.locator', problem: 'invalid' })
    }
  })

  it('a page, paragraph, slide or line that is not a positive integer is refused (was minimum)', () => {
    for (const locator of [
      { kind: 'page', page: 0 },
      { kind: 'paragraph', index: -1 },
      { kind: 'slide', slide: 1.5 },
      { kind: 'line', from: 0, to: 2 },
    ]) {
      expect(errorOf(withSource({ evidenceId: 'e1', locator }))).toEqual({
        path: 'segments.0.sources.0.locator',
        problem: 'invalid',
      })
    }
  })

  it('a short text over its limit is refused (was maxLength)', () => {
    const subject = valid()
    ;(subject.contradictions[0] as { subject: string }).subject = 's'.repeat(
      ANSWER_LIMITS.shortTextMax + 1,
    )
    expect(errorOf(subject)).toEqual({ path: 'contradictions.0.subject', problem: 'too_long' })
    const question = valid()
    ;(question.absences[0] as { question: string }).question = 'q'.repeat(
      ANSWER_LIMITS.shortTextMax + 1,
    )
    expect(errorOf(question)).toEqual({ path: 'absences.0.question', problem: 'too_long' })
  })
})

const PORTABLE = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
])

/** Every keyword of a schema outside the portable profile, with its place. */
function nonPortable(schema: unknown, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  return Object.entries(schema as Record<string, unknown>).flatMap(([key, value]) => {
    if (!PORTABLE.has(key)) return [`${path}${key}`]
    if (key === 'properties') {
      return Object.entries(value as Record<string, unknown>).flatMap(([name, sub]) =>
        nonPortable(sub, `${path}${name}.`),
      )
    }
    if (key === 'items') return nonPortable(value, `${path}items.`)
    if (key === 'anyOf')
      return (value as unknown[]).flatMap((s, i) => nonPortable(s, `${path}${i}.`))
    return []
  })
}

describe('modelAnswerSchema', () => {
  it('describes the same contract, closed to other fields', () => {
    expect(modelAnswerSchema.required).toEqual(['lang', 'segments', 'contradictions', 'absences'])
    expect(modelAnswerSchema.additionalProperties).toBe(false)
    const segmentProps = modelAnswerSchema.properties.segments.items.properties
    expect(segmentProps.nature.enum).toEqual(['fact', 'inference', 'suggestion'])
    expect(segmentProps.text.type).toBe('string')
    expect(JSON.stringify(modelAnswerSchema)).not.toMatch(/date|fresh|title/i)
  })

  it('is portable: no pattern, length, count, range or format keyword', () => {
    expect(nonPortable(modelAnswerSchema)).toEqual([])
  })
})
