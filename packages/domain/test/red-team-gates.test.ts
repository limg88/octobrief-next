import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  acceptAnomaly,
  COMMON_GATES,
  decideAnomaly,
  declaredCellId,
  declaredPeriod,
  draftSegmentKey,
  GATE_CLASS,
  type InternalDocument,
  isAcceptableCode,
  projectClientVersion,
  type RedTeamAnomaly,
  redTeamFindingText,
  segmentsWithoutSource,
  sensitiveKindsIn,
  technicalKindsIn,
  type VerifiedAnswer,
} from '../src/recipe/index.ts'
import { audienceContext, internalDocument, recipeOf } from './support/client-version.ts'
import { fakePassword } from './support/fake-credential.ts'
import { cleanDraft, redTeam, redTeamContext, segment, summaryText } from './support/red-team.ts'
import { growthSlope, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

const codes = (as: readonly RedTeamAnomaly[]) => as.map((a) => a.code)

function onlyCode(as: readonly RedTeamAnomaly[], code: string): RedTeamAnomaly[] {
  return as.filter((a) => a.code === code)
}

/** A fake secret built at run time, so no secret-shaped literal sits in the repository. */
const fake = (...parts: string[]): string => parts.join('')

describe('common gates', () => {
  it('finds nothing but warnings in a draft with every datum cited', () => {
    const r = redTeam(cleanDraft(), redTeamContext())
    expect(r.anomalies).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual([
      'source_freshness_warning',
      'source_freshness_warning',
      'story_points_in_client',
    ])
    expect(r.warnings.at(-1)?.requiresConfirmation).toBe(true)
  })

  it('refuses to check a draft for the client without its client version', () => {
    const { client: _client, ...withoutClient } = redTeamContext()
    expect(() => redTeam(cleanDraft(), withoutClient)).toThrow('red_team_without_client_version')
  })

  it('reports a draft that no client version can be made of, as an anomaly nobody accepts', () => {
    const doc = cleanDraft()
    doc.title = 'Un altro titolo'
    const [a] = onlyCode(redTeam(doc, redTeamContext()).anomalies, 'client_version_inconsistent')
    expect(a).toMatchObject({ gate: 5, class: 'data', resolution: 'none' })
    expect(isAcceptableCode('client_version_inconsistent')).toBe(false)
  })

  it('runs the common gates in a fixed order', () => {
    const doc = cleanDraft()
    doc.sections = doc.sections.filter((s) => s.id !== 'order')
    doc.title = 'SAL economico del 3 novembre'
    summaryText(doc).segments.push(segment(`Accesso con password: ${fakePassword()}`, [2]))
    const r = redTeam(doc, redTeamContext())
    expect(r.gates.map((g) => g.gate)).toEqual([...COMMON_GATES])
    expect(r.gates.map((g) => g.class)).toEqual(COMMON_GATES.map((g) => GATE_CLASS[g]))
    expect(r.gates.map((g) => g.class)).toEqual([
      'data',
      'data',
      'form',
      'data',
      'data',
      'data',
      'form',
      'structure',
      'data',
      'data',
    ])
    // The common gates first, in their order; then the checks of the recipe (no gate).
    const gates = r.anomalies.map((a) => a.gate)
    const common = gates.filter((g) => g !== null) as number[]
    expect(common).toEqual([...common].sort((a, b) => a - b))
    expect(new Set(common)).toEqual(new Set([3, 5, 6, 8]))
    expect(gates.slice(common.length).every((g) => g === null)).toBe(true)
    expect(r.anomalies.at(-1)?.code).toBe('recipe_check_not_evaluable')
    expect(r.anomalies.find((a) => a.gate === 8)?.class).toBe('structure')
  })

  it('counts every element it checks', () => {
    const r = redTeam(cleanDraft(), redTeamContext())
    for (const g of r.gates) {
      if (g.gate === 5 || g.gate === 9 || g.gate === 10) continue
      expect(g.checks).toBeGreaterThan(0)
    }
  })

  it('marks a credential in the text as not acceptable', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(
      segment(`Accesso al portale con password: ${fakePassword()}`, [2]),
    )
    const r = redTeam(doc, redTeamContext())
    const [credential] = onlyCode(r.anomalies, 'credential_in_text')
    expect(credential).toMatchObject({ gate: 6, class: 'data', resolution: 'none', status: 'open' })
    expect(isAcceptableCode('credential_in_text')).toBe(false)
    expect(
      acceptAnomaly(credential as RedTeamAnomaly, {
        reason: 'Il cliente conosce già questa password di prova',
        by: 'pm',
        at: '2026-11-06T10:00:00.000Z',
      }),
    ).toEqual({ ok: false, refusal: 'not_acceptable' })
    // An acceptance written by hand does not close it either.
    const forged = redTeam(
      doc,
      redTeamContext({
        acceptances: [
          {
            code: 'credential_in_text',
            refKey: (credential as RedTeamAnomaly).refKey,
            contentHash: (credential as RedTeamAnomaly).contentHash,
            reason: 'Il cliente conosce già questa password di prova',
            by: 'pm',
            at: '2026-11-06T10:00:00.000Z',
          },
        ],
      }),
    )
    expect(onlyCode(forged.anomalies, 'credential_in_text')[0]?.status).toBe('open')
  })

  it('finds secrets and credentials in every kind of text, split or not', () => {
    expect(sensitiveKindsIn(`chiave ${fake('AKIA', 'IOSFODNN7EXAMPLE')} nel repository`)).toEqual([
      'secret',
    ])
    expect(
      sensitiveKindsIn(`token ${fake('ghp_', '0123456789abcdefghijklmnopqrstuvwxyzAB')}`),
    ).toEqual(['secret'])
    expect(sensitiveKindsIn('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['secret'])
    expect(sensitiveKindsIn(`api_key = ${fake('abcdEFGH', '12345678xyz')}`)).toEqual(['secret'])
    expect(sensitiveKindsIn('https://mario:Segreto99@intranet.example/x')).toEqual(['credential'])
    expect(sensitiveKindsIn(`Authorization: Bearer ${fake('abcdefgh', 'ijklmnop1234')}`)).toEqual([
      'credential',
    ])
    expect(sensitiveKindsIn(`pass\u200bword: ${fakePassword()}`)).toEqual(['credential'])
    expect(sensitiveKindsIn(fake('AKIA\u200b', 'IOSFODNN7EXAMPLE'))).toEqual(['secret'])
    // Ordinary project text is not a credential.
    expect(sensitiveKindsIn('La password del portale va rinnovata entro venerdì.')).toEqual([])
    expect(sensitiveKindsIn('password: scaduta')).toEqual([])
    expect(sensitiveKindsIn('Il task-force meeting è confermato.')).toEqual([])
    // Typographic apostrophes, the schemes of authorization and the tokens of the trackers.
    expect(sensitiveKindsIn('parola d’ordine: Abc12345')).toEqual(['credential'])
    expect(sensitiveKindsIn('Authorization: Basic dXNlcjpwYXNz')).toEqual(['credential'])
    expect(sensitiveKindsIn(`jira ${fake('ATATT', '3xFfGF0abcdefghijklmnopqrstuvwxyz')}`)).toEqual([
      'secret',
    ])
    expect(sensitiveKindsIn(fake('glpat-', 'abcdefghijklmnopqrst'))).toEqual(['secret'])
    expect(sensitiveKindsIn(fake('SharedAccessKey=', 'abcdefghijklmnopqrstuvwxyz0123='))).toEqual([
      'secret',
    ])
    expect(sensitiveKindsIn(`token ${'abcdefgh234567'.repeat(4).slice(0, 52)}`)).toEqual(['secret'])
    expect(sensitiveKindsIn('ADO PAT: 7ylxk2p3dw5zjv4n6hq8r9s0t1u2v3w4x5y6z7a8b9c0d1')).toEqual([
      'credential',
    ])
    const keyLike = ['Abc1', '2345', 'xyzw', '9876'].join('')
    for (const word of ['pass', 'segreto', 'chiave', 'token', 'pat']) {
      expect(sensitiveKindsIn(`${word}: ${keyLike}`)).toEqual(['credential'])
    }
    expect(sensitiveKindsIn('chiave: valore')).toEqual([])
    expect(sensitiveKindsIn('token: scaduto')).toEqual([])
  })

  it('finds credentials and secrets written with look-alike letters of other alphabets', () => {
    const CYRILLIC_A = 'а'
    const CYRILLIC_O = 'о'
    const GREEK_OMICRON = 'ο'
    const GREEK_KAPPA = 'Κ'
    const keyLike = fake('ghx7', 'Qw9z', 'LmPa')
    expect(sensitiveKindsIn(fake('p', CYRILLIC_A, 'ssword: ', fakePassword()))).toEqual([
      'credential',
    ])
    expect(sensitiveKindsIn(fake('t', CYRILLIC_O, 'ken: ', keyLike))).toEqual(['credential'])
    expect(sensitiveKindsIn(fake('t', GREEK_OMICRON, 'ken: ', keyLike))).toEqual(['credential'])
    expect(sensitiveKindsIn(fake('A', GREEK_KAPPA, 'IA', 'IOSFODNN7EXAMPLE'))).toEqual(['secret'])
    expect(
      sensitiveKindsIn(fake('Auth', CYRILLIC_O, 'rization: Bearer ', 'abcdefgh', 'ijklmnop1234')),
    ).toEqual(['credential'])
  })

  it('catches short secrets after a keyword', () => {
    for (const text of [
      fake('pass: ', fakePassword()),
      fake('segreto: ', 'S3gr3to!', '2026'),
      fake('token: ', '48213907', '55126634'),
      fake('chiave: ', 'Abc1', '2345.'),
    ]) {
      expect(sensitiveKindsIn(text), text).toEqual(['credential'])
    }
  })

  it('takes whatever follows a word that only names a password as one, from six characters', () => {
    for (const text of [
      fake('password: ', 'abc', '123'),
      // Random, but never a plain word: six hex letters alone read as an ordinary word.
      fake('pwd: ', randomBytes(2).toString('hex'), '9x'),
      fake('password: ', '12/12', '/2026'),
      fake('passcode: ', 'OCTO', '-1234'),
    ]) {
      expect(sensitiveKindsIn(text), text).toEqual(['credential'])
    }
    expect(sensitiveKindsIn('password: scaduta')).toEqual([])
    expect(sensitiveKindsIn(fake('password: ', 'ab', '1'))).toEqual([])
  })

  it('finds no credential in ordinary Italian after a keyword', () => {
    for (const text of [
      'chiave: priorità',
      'Parola chiave: sostenibilità del modulo.',
      'chiave: OCTO-1234',
      'token: 20261130',
      'pat: 2026-11-30',
      'segreto: 12/12/2026',
      'pass: 30/11/2026',
      'chiave: responsabilità condivisa',
      'chiave: capo-progetto',
      'chiave: valore',
      'token: scaduto',
      'segreto: 12/12/2026.',
      'pass: approvato',
    ]) {
      expect(sensitiveKindsIn(text), text).toEqual([])
    }
  })

  it('finds secrets in the cells and in the notes for the PM', () => {
    const doc = cleanDraft()
    const table = doc.sections[0]?.blocks[0]
    if (table?.kind !== 'table') throw new Error('sample draft without its table')
    ;(table.rows[0]?.cells[1] as { text: string }).text = [
      'sk',
      'abcdefghijklmnopqrstuvwxyz0123',
    ].join('-')
    doc.internalNotes.push(segment(`Chiave di prova: ${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}`))
    const r = redTeam(doc, redTeamContext())
    const secrets = onlyCode(r.anomalies, 'secret_in_text').map((a) => a.ref.element)
    expect(secrets.sort()).toEqual(['cell', 'internal_note'])
  })

  it('treats a cited work item id as data, not as a technical identifier', () => {
    const doc = cleanDraft()
    doc.sourceNotes.push({
      n: 5,
      label: 'Storia PROJ-123 «Firma digitale»',
      dataAsOf: '2026-11-06T06:00:00.000Z',
      ref: { kind: 'work_item', sourceId: 'ado', id: 'PROJ-123' },
    })
    summaryText(doc).segments.push(segment('La storia PROJ-123 è chiusa.', [5]))
    expect(onlyCode(redTeam(doc, redTeamContext()).anomalies, 'technical_identifier')).toEqual([])

    const uncited = cleanDraft()
    summaryText(uncited).segments.push(segment('La storia PROJ-123 è chiusa.', [2]))
    const [found] = onlyCode(redTeam(uncited, redTeamContext()).anomalies, 'technical_identifier')
    expect(found).toMatchObject({ gate: 7, class: 'form', slot: 'summary_text' })
  })

  it('finds paths and hashes, never cited ids', () => {
    const none = new Set<string>()
    expect(technicalKindsIn('Il file è in /srv/octobrief/export.xlsx', none, 'it')).toEqual([
      'path',
    ])
    expect(technicalKindsIn('Vedi C:\\Progetti\\sal.docx', none, 'it')).toEqual(['path'])
    expect(technicalKindsIn('impronta sha256:0123456789abcdef0123', none, 'it')).toEqual([
      'identifier',
    ])
    expect(technicalKindsIn('Dal 01/10/2026 al 31/10/2026, e/o in km/h.', none, 'it')).toEqual([])
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(technicalKindsIn(`riga ${uuid}`, none, 'it')).toEqual(['identifier'])
    expect(technicalKindsIn(`riga ${uuid}`, new Set([uuid]), 'it')).toEqual([])
  })

  it('raises one stale-source anomaly per source, not per cell', () => {
    const r = redTeam(
      cleanDraft(),
      redTeamContext({
        freshness: { ...redTeamContext().freshness, now: '2026-11-12T09:30:00.000Z' },
      }),
    )
    const stale = onlyCode(r.anomalies, 'stale_source')
    expect(stale.map((a) => a.refKey).sort()).toEqual([
      '{"element":"source","source":"evidence:ev-dwsi"}',
      '{"element":"source","source":"system:dwsi"}',
      '{"element":"source","source":"tracker:ado"}',
    ])
    // The warehouse is cited by many cells through two notes: one anomaly, its numbers suspended.
    const dwsi = stale.find((a) => a.refKey.includes('system:dwsi'))
    expect(dwsi?.detail.notes).toEqual([1, 4])
    expect(r.anomalies.every((a) => a.ref.element !== 'cell')).toBe(true)
    expect(dwsi?.resolution).toBe('acceptance')
    expect(redTeamFindingText(dwsi as RedTeamAnomaly, 'it')).toContain('sospesi')
  })

  it('warns between the thresholds, with the stricter thresholds of the recipe for its kind', () => {
    // 26 hours: past the 12 hours of the recipe for the warehouse and the 24 of the project.
    const r = redTeam(cleanDraft(), redTeamContext())
    expect(
      r.warnings
        .filter((w) => w.code === 'source_freshness_warning')
        .map((w) => w.refKey)
        .sort(),
    ).toEqual([
      '{"element":"source","source":"evidence:ev-dwsi"}',
      '{"element":"source","source":"system:dwsi"}',
    ])
    // 50 hours: past the stop of the recipe (48) for the warehouse only.
    const later = redTeam(
      cleanDraft(),
      redTeamContext({
        freshness: { ...redTeamContext().freshness, now: '2026-11-07T09:00:00.000Z' },
      }),
    )
    expect(onlyCode(later.anomalies, 'stale_source').map((a) => a.refKey)).toEqual([
      '{"element":"source","source":"system:dwsi"}',
    ])
    expect(later.warnings.map((w) => w.refKey)).toContain(
      '{"element":"source","source":"evidence:ev-dwsi"}',
    )
  })

  it('judges only system data by age, and fails closed on an undated or future source', () => {
    const documents = redTeam(
      cleanDraft(),
      redTeamContext({
        freshness: {
          ...redTeamContext().freshness,
          now: '2026-11-30T09:30:00.000Z',
          evidence: { 'ev-dwsi': { policy: 'document', sourceKind: 'manual_upload' } },
        },
      }),
    )
    expect(documents.anomalies.some((a) => a.refKey.includes('evidence:ev-dwsi'))).toBe(false)

    const undated = cleanDraft()
    ;(undated.sourceNotes[1] as { dataAsOf: string | null }).dataAsOf = null
    const future = cleanDraft()
    ;(future.sourceNotes[1] as { dataAsOf: string | null }).dataAsOf = '2026-11-20T00:00:00.000Z'
    expect(codes(redTeam(undated, redTeamContext()).anomalies)).toEqual([
      'source_freshness_unknown',
    ])
    expect(codes(redTeam(future, redTeamContext()).anomalies)).toEqual(['source_date_in_future'])
  })

  it('wants a source for a statement of fact and for every value shown', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Il collaudo è terminato.', [], 'fact'))
    const value = doc.sections[0]?.blocks[1]
    if (value?.kind !== 'value') throw new Error('sample draft without its total')
    value.cell.sources = []
    const r = redTeam(doc, redTeamContext())
    expect(onlyCode(r.anomalies, 'without_source')[0]).toMatchObject({ gate: 1, class: 'data' })
    expect(onlyCode(r.anomalies, 'value_without_source')[0]).toMatchObject({
      gate: 4,
      class: 'data',
      resolution: 'none',
    })
    // «Non dedotto» is not an anomaly.
    const notDeduced = cleanDraft()
    const total = notDeduced.sections[0]?.blocks[1]
    if (total?.kind !== 'value') throw new Error('sample draft without its total')
    total.cell.text = null
    total.cell.sources = []
    expect(
      onlyCode(redTeam(notDeduced, redTeamContext()).anomalies, 'value_without_source'),
    ).toEqual([])
  })

  it('names the section and a short excerpt of a text without a verified source', () => {
    const doc = cleanDraft()
    const long =
      'Il collaudo è terminato con esito positivo su tutti gli ambienti previsti dal piano di rilascio concordato.'
    summaryText(doc).segments.push(segment(long, [], 'fact'))
    doc.internalNotes.push(segment('Il cliente ha confermato la data.', [], 'fact'))
    const found = onlyCode(redTeam(doc, redTeamContext()).anomalies, 'without_source')
    expect(found).toHaveLength(2)
    const [inText, inNote] = found.map((a) => redTeamFindingText(a, 'it'))
    expect(inText).toContain('Sintesi')
    expect(inText).toContain('«Il collaudo è terminato con esito positivo')
    expect(inText).toContain('…»')
    expect(inText).not.toContain('piano di rilascio concordato')
    // A note for the PM is in no section: the card says it is a note, with its words.
    expect(inNote).toContain('in una nota per te')
    expect(inNote).toContain('«Il cliente ha confermato la data.»')
  })

  it('tells which texts of the draft are without a verified source, for the draft to show', () => {
    const doc = cleanDraft()
    const text = segment('Il collaudo è terminato.', [], 'fact')
    const note = segment('Il cliente ha confermato la data.', [], 'fact')
    summaryText(doc).segments.push(text)
    doc.internalNotes.push(note)
    const r = redTeam(doc, redTeamContext())
    const flagged = segmentsWithoutSource(r.anomalies)
    expect(flagged.has(draftSegmentKey('summary_text', text))).toBe(true)
    expect(flagged.has(draftSegmentKey(null, note))).toBe(true)
    // A text with its source is not among them.
    const cited = summaryText(doc).segments[0]
    if (!cited) throw new Error('sample draft without its text')
    expect(flagged.has(draftSegmentKey('summary_text', cited))).toBe(false)
    // An anomaly the PM accepted is no longer shown as one.
    const accepted = r.anomalies.map((a) => ({ ...a, status: 'accepted' as const }))
    expect(segmentsWithoutSource(accepted).size).toBe(0)
  })

  it('never repeats a credential in the excerpt of a finding', () => {
    const doc = cleanDraft()
    const password = fakePassword()
    summaryText(doc).segments.push(segment(`Accesso con password: ${password}`, [], 'fact'))
    const [a] = onlyCode(redTeam(doc, redTeamContext()).anomalies, 'without_source')
    expect(a?.detail.excerpt).toBeUndefined()
    expect(redTeamFindingText(a as RedTeamAnomaly, 'it')).not.toContain(password)
  })

  it('refuses a citation of a note the draft does not have', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Ordine confermato.', [9]))
    expect(codes(redTeam(doc, redTeamContext()).anomalies)).toContain('source_note_missing')
  })

  it('keeps the findings of the verifier on what the model wrote', () => {
    const verified = {
      lang: 'it',
      segments: [
        {
          text: null,
          originalText: 'Il budget residuo è di 4.000 €.',
          nature: 'fact',
          sources: [],
          inScope: true,
          dataKinds: ['number', 'amount'],
          mentionsKnownName: false,
          mixedScript: false,
          withoutSource: true,
          freshness: 'unknown',
          warning: null,
          contested: false,
          numbersSuspended: true,
          suspendedReason: 'without_source',
        },
      ],
      contradictions: [],
      absences: [],
      checks: { total: 4, anomalies: 1, list: [{ code: 'without_source', index: 0 }] },
    } as unknown as VerifiedAnswer
    const r = redTeam(
      cleanDraft(),
      redTeamContext({ slotVerifications: { summary_text: verified } }),
    )
    expect(onlyCode(r.anomalies, 'without_source')[0]).toMatchObject({
      gate: 1,
      slot: 'summary_text',
      ref: { element: 'segment', section: 'summary', block: 'summary_text' },
    })
  })

  it('wants link phrases and titles without data', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Ne parliamo il 12 novembre.'))
    ;(doc.sections[1] as { title: string }).title = 'Sintesi del periodo ottobre 2026'
    ;(doc.sections[2] as { title: string }).title = 'Avanzamento al 5 novembre'
    const r = redTeam(doc, redTeamContext())
    expect(onlyCode(r.anomalies, 'connector_with_data')[0]).toMatchObject({
      gate: 3,
      class: 'form',
      slot: 'summary_text',
    })
    // A title with the value of a parameter is the recipe's title: no anomaly.
    expect(onlyCode(r.anomalies, 'title_with_data').map((a) => a.ref)).toEqual([
      { element: 'section_title', section: 'progress' },
    ])
  })

  it('checks the structure of the recipe: mandatory sections, order, blocks and columns', () => {
    const doc = cleanDraft()
    const [order, summary, progress, team] = doc.sections as [
      InternalDocument['sections'][number],
      InternalDocument['sections'][number],
      InternalDocument['sections'][number],
      InternalDocument['sections'][number],
    ]
    doc.sections = [summary, progress, team]
    const gated = (d: InternalDocument) =>
      codes(redTeam(d, redTeamContext()).anomalies.filter((a) => a.gate !== null))
    expect(gated(doc)).toEqual(['required_section_missing'])

    doc.sections = [order, progress, summary, team]
    expect(gated(doc)).toEqual(['section_out_of_order'])

    const columns = cleanDraft()
    const table = columns.sections[0]?.blocks[0]
    if (table?.kind !== 'table') throw new Error('sample draft without its table')
    table.columns.pop()
    const r = redTeam(columns, redTeamContext())
    expect(codes(r.anomalies)).toEqual(['columns_mismatch', 'row_cells_mismatch'])
    expect(r.anomalies.every((a) => a.class === 'structure' && a.resolution === 'none')).toBe(true)
  })

  it('shows contradictions until the PM decides, with a reason, on the same sides', () => {
    const contradiction = {
      key: 'order_total',
      subject: "Totale dell'ordine",
      sides: [
        {
          value: '12.000,00 €',
          source: { kind: 'fact' as const, factId: 'fact-a' },
        },
        {
          value: '11.500,00 €',
          source: { kind: 'fact' as const, factId: 'fact-b' },
        },
      ],
    }
    const r = redTeam(cleanDraft(), redTeamContext({ contradictions: [contradiction] }))
    const [open] = onlyCode(r.anomalies, 'contradiction_open')
    expect(open).toMatchObject({ gate: 9, class: 'data', resolution: 'decision', status: 'open' })
    expect(
      acceptAnomaly(open as RedTeamAnomaly, { reason: 'x'.repeat(30), by: 'pm', at: 'now' }),
    ).toEqual({
      ok: false,
      refusal: 'not_acceptable',
    })
    expect(
      decideAnomaly(open as RedTeamAnomaly, {
        choice: 'fact-a',
        reason: 'breve',
        by: 'pm',
        at: 'now',
      }),
    ).toEqual({ ok: false, refusal: 'reason_too_short' })
    const decided = decideAnomaly(open as RedTeamAnomaly, {
      choice: 'fact-a',
      reason: "Vale l'ordine firmato, la mail era una bozza.",
      by: 'pm',
      at: '2026-11-06T10:00:00.000Z',
    })
    if (!decided.ok) throw new Error('decision refused')
    const after = redTeam(
      cleanDraft(),
      redTeamContext({ contradictions: [contradiction], decisions: [decided.decision] }),
    )
    expect(onlyCode(after.anomalies, 'contradiction_open')[0]?.status).toBe('decided')
    // A new side opens it again.
    const changed = {
      ...contradiction,
      sides: [
        ...contradiction.sides,
        { value: '9.000,00 €', source: { kind: 'fact' as const, factId: 'fact-c' } },
      ],
    }
    const again = redTeam(
      cleanDraft(),
      redTeamContext({ contradictions: [changed], decisions: [decided.decision] }),
    )
    expect(onlyCode(again.anomalies, 'contradiction_open')[0]?.status).toBe('open')
  })

  it('keeps a gathered contradiction apart from a contested fact with the same key', () => {
    const doc = cleanDraft()
    doc.sourceNotes.push({
      n: 5,
      label: 'Rischio sul collaudo',
      dataAsOf: '2026-11-06T06:00:00.000Z',
      ref: { kind: 'fact', factId: 'fact-risk' },
    })
    summaryText(doc).segments.push(segment('Il collaudo è a rischio.', [5]))
    const gathered = {
      key: 'fact:fact-risk',
      subject: 'Collaudo',
      sides: [
        { value: 'a rischio', source: { kind: 'fact' as const, factId: 'fact-risk' } },
        { value: 'in linea', source: { kind: 'fact' as const, factId: 'fact-b' } },
      ],
    }
    const r = redTeam(
      doc,
      redTeamContext({ contestedFacts: ['fact-risk'], contradictions: [gathered] }),
    )
    expect(onlyCode(r.anomalies, 'contradiction_open')).toHaveLength(2)
  })

  it('lets the PM keep a known name in a link phrase, never a number', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(segment('Ne parliamo con Mario Rossi.'))
    const [a] = onlyCode(
      redTeam(doc, redTeamContext({ knownNames: ['Mario Rossi'] })).anomalies,
      'connector_with_name',
    )
    expect(a).toMatchObject({ gate: 3, class: 'form', resolution: 'acceptance' })
    expect(isAcceptableCode('connector_with_name')).toBe(true)
    expect(isAcceptableCode('connector_with_data')).toBe(false)
  })

  it('does not see a changed declared value in a cell the client version withholds', () => {
    const doc = cleanDraft()
    const total = doc.sections[0]?.blocks[1]
    if (total?.kind !== 'value') throw new Error('sample draft without its total')
    total.cell.category = 'costs'
    total.cell.operandCategories = ['costs']
    const declared = {
      recipeSlug: 'sal-economico',
      sectionId: 'order',
      cellId: declaredCellId('order_total'),
      period: '2026-10-01..2026-10-31',
      value: '12.000,00 €',
      declaredAt: '2026-11-01T00:00:00.000Z',
    }
    const r = redTeam(doc, redTeamContext({ declaredValues: [declared] }))
    expect(codes(r.anomalies)).toContain('internal_data_in_client')
    expect(codes(r.anomalies)).not.toContain('declared_value_changed')
  })

  it('raises one contradiction per contested fact the draft cites', () => {
    const doc = cleanDraft()
    doc.sourceNotes.push({
      n: 5,
      label: 'Rischio sul collaudo',
      dataAsOf: '2026-11-06T06:00:00.000Z',
      ref: { kind: 'fact', factId: 'fact-risk' },
    })
    summaryText(doc).segments.push(
      segment('Il collaudo è a rischio.', [5]),
      segment('Serve una data.', [5]),
    )
    const r = redTeam(doc, redTeamContext({ contestedFacts: ['fact-risk'] }))
    expect(onlyCode(r.anomalies, 'contradiction_open').map((a) => a.refKey)).toEqual([
      '{"contradiction":"fact:fact-risk","element":"contradiction"}',
    ])
  })

  it('flags a changed declared value for the same recipe, section, cell and period', () => {
    const recipe = recipeOf()
    const audience = audienceContext(recipe)
    const period = declaredPeriod(recipe, redTeamContext().periods)
    expect(period).toBe('2026-10-01..2026-10-31')
    const declared = {
      recipeSlug: 'sal-economico',
      sectionId: 'order',
      cellId: declaredCellId('order_total'),
      period,
      value: '10.000,00 €',
      declaredAt: '2026-11-01T10:00:00.000Z',
    }
    const run = (d: typeof declared) =>
      onlyCode(
        redTeam(internalDocument(), redTeamContext({ client: { audience }, declaredValues: [d] }))
          .anomalies,
        'declared_value_changed',
      )
    const [changed] = run(declared)
    expect(changed).toMatchObject({
      gate: 10,
      class: 'data',
      resolution: 'decision',
      ref: { element: 'declared_value', section: 'order', cell: '["order_total"]' },
      detail: { declared: '10.000,00 €', current: '12.000,00 €' },
    })
    expect(redTeamFindingText(changed as RedTeamAnomaly, 'it')).toContain('«10.000,00 €»')
    expect(run({ ...declared, period: '2026-09-01..2026-09-30' })).toEqual([])
    expect(run({ ...declared, recipeSlug: 'closing-status' })).toEqual([])
    expect(run({ ...declared, sectionId: 'summary' })).toHaveLength(1)
    expect(run({ ...declared, value: '12.000,00 €' })).toEqual([])
    // A cell of a table, by its row key.
    expect(
      run({
        ...declared,
        cellId: declaredCellId('positions', 'amount', '["1"]'),
        value: '12.000,00 €',
      }),
    ).toEqual([])
    expect(
      run({
        ...declared,
        cellId: declaredCellId('positions', 'amount', '["1"]'),
        value: '11.000,00 €',
      }),
    ).toHaveLength(1)
  })

  it('runs the client gate on the client version and keeps its acceptances', () => {
    const audience = audienceContext()
    const { report } = projectClientVersion(internalDocument(), audience)
    const margin = report.anomalies.find((a) => a.code === 'internal_data_in_client')
    if (margin === undefined) throw new Error('the sample draft has a margin for the client')
    const r = redTeam(internalDocument(), redTeamContext({ client: { audience } }))
    const [found] = onlyCode(r.anomalies, 'internal_data_in_client')
    expect(found).toMatchObject({ gate: 5, refKey: margin.refKey, contentHash: margin.contentHash })
    expect(r.warnings.map((w) => w.code)).toContain('story_points_in_client')
    expect(r.gates.find((g) => g.gate === 5)?.checks).toBeGreaterThan(0)

    const accepted = acceptAnomaly(margin, {
      reason: 'Il cliente ha chiesto di vedere il margine del mese.',
      by: 'pm',
      at: '2026-11-06T10:00:00.000Z',
    })
    if (!accepted.ok) throw new Error('acceptance refused')
    const after = redTeam(
      internalDocument(),
      redTeamContext({ client: { audience }, acceptances: [accepted.acceptance] }),
    )
    expect(onlyCode(after.anomalies, 'internal_data_in_client')[0]?.status).toBe('accepted')
    expect(redTeamFindingText(found as RedTeamAnomaly, 'it')).toContain('cliente')
  })

  it('warns of a suspicious instruction in evidence the draft uses, without blocking', () => {
    const hits = {
      'ev-dwsi': [
        { pattern: 'ignore_rules' as const, chunkIndex: 2 },
        { pattern: 'ignore_rules' as const, chunkIndex: 5 },
      ],
      'ev-minutes': [{ pattern: 'send_externally' as const, chunkIndex: 0 }],
    }
    const r = redTeam(cleanDraft(), redTeamContext({ suspicious: hits }))
    const suspicious = r.warnings.filter((w) => w.code === 'suspicious_instruction')
    expect(suspicious).toHaveLength(1)
    expect(suspicious[0]).toMatchObject({
      ref: { element: 'source', source: 'evidence:ev-dwsi' },
      detail: { pattern: 'ignore_rules', chunks: [2, 5] },
      requiresConfirmation: false,
    })
    expect(r.anomalies).toEqual([])
  })

  it('has a text for the PM for every finding, without codes', () => {
    const doc = cleanDraft()
    summaryText(doc).segments.push(
      segment(
        `Il file è in /srv/export/sal.xlsx, con api_key=${fake('abcdEFGH', '12345678')}`,
        [2],
      ),
    )
    const r = redTeam(doc, redTeamContext())
    for (const a of r.anomalies) {
      const text = redTeamFindingText(a, 'it')
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/)
      expect(text.length).toBeGreaterThan(10)
    }
  })

  it('runs the gates in linear time on a large draft', { timeout: TIMING_TEST_TIMEOUT_MS }, () => {
    const FULL = 4_000
    const { slope } = growthSlope((fraction) => {
      const doc = cleanDraft()
      const table = doc.sections[0]?.blocks[0]
      if (table?.kind !== 'table') throw new Error('sample draft without its table')
      const row = table.rows[0] as (typeof table.rows)[number]
      const n = Math.round(FULL * fraction)
      table.rows = Array.from({ length: n }, (_, i) => ({
        ...structuredClone(row),
        key: String(i),
      }))
      const text = summaryText(doc)
      for (let i = 0; i < n / 10; i++) {
        text.segments.push(segment(`Riga ${i} con 0f8fad5b${'a'.repeat(40)} e /srv/x/y`, [2]))
      }
      const ctx = redTeamContext()
      return () => redTeam(doc, ctx)
    })
    expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
  })

  it('reads long texts in linear time', { timeout: TIMING_TEST_TIMEOUT_MS }, () => {
    const FULL = 200_000
    const { slope } = growthSlope((fraction) => {
      const n = Math.round(FULL * fraction)
      const text = [
        'a'.repeat(n),
        'z password: ',
        'x'.repeat(n),
        ' ',
        '/a'.repeat(n / 2),
        ' sk-',
        'b'.repeat(n / 4),
        ' ',
        'pass: '.repeat(n / 6),
        ' ',
        'authorization: basic '.repeat(n / 20),
        ' ',
        'a2'.repeat(n / 2),
        'Z',
        ' ',
        'f'.repeat(n),
        'g',
      ].join('')
      return () => {
        sensitiveKindsIn(text)
        technicalKindsIn(text, new Set(), 'it')
      }
    })
    expect(slope).toBeLessThan(MAX_GROWTH_SLOPE)
  })
})

describe('a credential in the title of a cited piece of evidence', () => {
  it('blocks the draft and tells the PM to rename or remove that evidence', () => {
    const doc = cleanDraft()
    const note = doc.sourceNotes[0]
    if (!note) throw new Error('sample draft without notes')
    note.label = `Accessi password: ${fake('Xk9#', 'pq7Lm2')}`
    const found = onlyCode(redTeam(doc, redTeamContext()).anomalies, 'credential_in_text')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ resolution: 'none', ref: { element: 'source_note' } })
    const text = redTeamFindingText(found[0] as RedTeamAnomaly, 'it')
    expect(text).toContain('Rinomina il documento o toglilo dal progetto')
    expect(text).not.toContain('pq7Lm2')
  })
})
