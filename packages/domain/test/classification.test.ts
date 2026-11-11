import { describe, expect, it } from 'vitest'
import { classify, isInternalOnly } from '../src/classification.ts'
import { romeMidnight } from '../src/rome-time.ts'

const acquiredAt = new Date('2026-11-05T09:00:00Z')
const base = {
  fileName: 'notes.txt',
  mediaType: 'text/plain',
  text: '',
  lang: 'it' as const,
  metadataDate: null,
  acquiredAt,
}

describe('classify', () => {
  it('audience defaults to internal and is marked uncertain', () => {
    const c = classify({
      ...base,
      fileName: 'SAL_2026-10-31.docx',
      text: 'Stato avanzamento lavori',
    })
    expect(c.audience).toBe('internal')
    expect(c.audienceSource).toBe('default')
    expect(c.uncertain).toContain('audience')
  })

  it('an export of a source system takes the kind the system gives and is internal by rule', () => {
    const systemDate = new Date('2026-11-05T08:30:00Z')
    const c = classify({
      ...base,
      fileName: 'Export ADO del 05/11 09:30',
      mediaType: 'text/csv',
      systemKind: 'backlog_export',
      systemDate,
    })
    expect(c).toEqual({
      kind: 'backlog_export',
      audience: 'internal',
      audienceSource: 'rule',
      dateOf: { date: systemDate, source: 'system' },
      uncertain: [],
    })
  })

  it('an export of a source system stays internal even when its name or text looks client-facing', () => {
    const c = classify({
      ...base,
      fileName: 'Export ADO per il cliente',
      text: 'Destinatario: cliente\n',
      systemKind: 'backlog_export',
    })
    expect(c.audience).toBe('internal')
    expect(c.audienceSource).toBe('rule')
    expect(c.uncertain).not.toContain('audience')
  })

  it('the PM choice of kind and audience wins over the kind the system gives', () => {
    const c = classify({
      ...base,
      fileName: 'Export ADO del 05/11 09:30',
      systemKind: 'backlog_export',
      pm: { kind: 'generic', audience: 'client' },
    })
    expect(c.kind).toBe('generic')
    expect(c.audience).toBe('client')
    expect(c.audienceSource).toBe('pm')
  })

  it('an economics export is internal by rule, whoever says otherwise', () => {
    for (const input of [
      { systemKind: 'economics_export' as const },
      { systemKind: 'economics_export' as const, pm: { audience: 'client' as const } },
      { pm: { kind: 'economics_export' as const, audience: 'client' as const } },
      {
        fileName: 'Conto economico per il cliente.xlsx',
        pm: { kind: 'economics_export' as const },
      },
    ]) {
      const c = classify({ ...base, ...input })
      expect(c.kind).toBe('economics_export')
      expect(c.audience).toBe('internal')
      expect(c.audienceSource).toBe('rule')
      expect(c.uncertain).not.toContain('audience')
    }
  })

  it('timesheets and economics of a source system are never for the client', () => {
    for (const systemKind of ['timesheet', 'economics_export'] as const) {
      const c = classify({ ...base, systemKind, pm: { audience: 'client' } })
      expect(c.audience).toBe('internal')
      expect(c.audienceSource).toBe('rule')
    }
    // An uploaded timesheet is a document like the others: the PM decides.
    const uploaded = classify({ ...base, pm: { kind: 'timesheet', audience: 'client' } })
    expect(uploaded.audience).toBe('client')
  })

  it('tells which kinds are internal only', () => {
    expect(isInternalOnly('economics_export')).toBe(true)
    expect(isInternalOnly('timesheet', true)).toBe(true)
    expect(isInternalOnly('timesheet')).toBe(false)
    expect(isInternalOnly('backlog_export', true)).toBe(false)
  })

  it('leaves an uploaded timesheet internal by default, for the PM to decide', () => {
    const c = classify({ ...base, fileName: 'timesheet ottobre.xlsx' })
    expect(c.kind).toBe('timesheet')
    expect(c.audience).toBe('internal')
    expect(c.audienceSource).toBe('default')
    expect(c.uncertain).toContain('audience')
  })

  it('the PM choice of audience, kind and date wins and is not uncertain', () => {
    const date = romeMidnight(2026, 1, 15)
    const c = classify({
      ...base,
      fileName: 'verbale.pdf',
      pm: { kind: 'contract', audience: 'client', date },
    })
    expect(c).toEqual({
      kind: 'contract',
      audience: 'client',
      audienceSource: 'pm',
      dateOf: { date, source: 'pm' },
      uncertain: [],
    })
  })

  it.each([
    ['SAL_2026-10-31.docx', '', 'status_report'],
    ['stato avanzamento ottobre.docx', '', 'status_report'],
    ['verbale 3 novembre 2026.pdf', '', 'meeting_minutes'],
    ['riunione-kickoff.docx', '', 'meeting_minutes'],
    ['call-trascrizione.txt', '', 'transcript'],
    ['contratto.pdf', '', 'contract'],
    ['foglio ore ottobre.xlsx', '', 'timesheet'],
    ['timesheet.csv', '', 'timesheet'],
    ['export jira.csv', '', 'backlog_export'],
    ['backlog.xlsx', '', 'backlog_export'],
    ['deck.pdf', '', 'presentation'],
  ])('reads the kind of %s from name or text', (fileName, text, kind) => {
    const c = classify({ ...base, fileName, text })
    expect(c.kind).toBe(kind)
    expect(c.uncertain).not.toContain('kind')
  })

  it('a kind read only from the text is used but marked uncertain', () => {
    const c = classify({ ...base, fileName: 'call.txt', text: 'Trascrizione della chiamata' })
    expect(c.kind).toBe('transcript')
    expect(c.uncertain).toContain('kind')
  })

  it('words too common in text (riunione, meeting, sprint) do not decide the kind from the text', () => {
    for (const text of ['Alla riunione di ieri', 'Weekly meeting', 'Lo sprint è finito']) {
      expect(classify({ ...base, text }).kind).toBe('generic')
    }
  })

  it('a pptx file is a presentation by its media type', () => {
    const c = classify({
      ...base,
      fileName: 'x.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    expect(c.kind).toBe('presentation')
  })

  it('the name wins over the text, and only the first 2000 characters are read', () => {
    expect(classify({ ...base, fileName: 'verbale.txt', text: 'contratto' }).kind).toBe(
      'meeting_minutes',
    )
    expect(classify({ ...base, text: `${'a '.repeat(1100)} contratto` }).kind).toBe('generic')
  })

  it('a document with no keyword is generic and its kind is uncertain', () => {
    const c = classify({ ...base, text: 'Appunti vari' })
    expect(c.kind).toBe('generic')
    expect(c.uncertain).toContain('kind')
  })

  it.each([
    ['SAL per il cliente.docx', ''],
    ['sal_client-facing.docx', ''],
    ['sal.docx', 'Destinatario: cliente\nTesto'],
    ['sal.docx', 'Titolo\n  Destinatario: il cliente  \nTesto'],
  ])('audience is client only with an explicit marker (%s)', (fileName, text) => {
    const c = classify({ ...base, fileName, text })
    expect(c).toMatchObject({ audience: 'client', audienceSource: 'rule' })
    expect(c.uncertain).not.toContain('audience')
  })

  it('a negated or internal marker never makes a document client-facing', () => {
    for (const fileName of [
      'Non per il cliente.docx',
      'SAL per il cliente - bozza interna.docx',
      'sal_per_il_cliente_riservato.docx',
      'SAL per il cliente confidenziale.docx',
    ]) {
      expect(classify({ ...base, fileName }).audience).toBe('internal')
    }
  })

  it('an explicit internal marker is a rule, not uncertain; a negation alone stays uncertain', () => {
    const marked = classify({ ...base, fileName: 'SAL per il cliente - bozza interna.docx' })
    expect(marked).toMatchObject({ audience: 'internal', audienceSource: 'rule' })
    expect(marked.uncertain).not.toContain('audience')
    const header = classify({ ...base, text: 'Destinatario: interno\nTesto' })
    expect(header).toMatchObject({ audience: 'internal', audienceSource: 'rule' })
    const negated = classify({ ...base, fileName: 'Non per il cliente.docx' })
    expect(negated).toMatchObject({ audience: 'internal', audienceSource: 'default' })
    expect(negated.uncertain).toContain('audience')
  })

  it('a client mentioned in passing does not make a document client-facing', () => {
    const c = classify({ ...base, text: 'Il cliente ha chiesto una revisione. Destinatari: team' })
    expect(c.audience).toBe('internal')
  })

  it('the date is uncertain only when it falls back to the acquisition', () => {
    expect(classify(base).uncertain).toContain('date')
    expect(classify({ ...base, fileName: 'a_2026-10-31.txt' }).uncertain).not.toContain('date')
    expect(classify(base).dateOf).toEqual({ date: acquiredAt, source: 'acquisition' })
  })
})

describe('delivery evidence kinds', () => {
  const kindOf = (fileName: string, text = '') => classify({ ...base, fileName, text }).kind

  it('recognizes a purchase order from its file name', () => {
    expect(kindOf('Ordine-PO-2026-014.md')).toBe('purchase_order')
    expect(kindOf('Ordine di acquisto 4500123.pdf')).toBe('purchase_order')
  })

  it('recognizes an invoice from its file name', () => {
    expect(kindOf('Fattura-FT-2026-031.md')).toBe('invoice')
  })

  it('recognizes the list of contract deliverables before the contract itself', () => {
    expect(kindOf('Contratto-deliverable-CT-2026-007.md')).toBe('contract_deliverables')
    expect(kindOf('Contratto-CT-2026-007.pdf')).toBe('contract')
  })

  it('recognizes each new kind from the heading of the text', () => {
    expect(kindOf('doc1.md', "# Ordine d'acquisto PO-9\n\nCliente: X")).toBe('purchase_order')
    expect(kindOf('doc2.md', '# Fattura FT-9\n\nData: 2026-10-01')).toBe('invoice')
    expect(kindOf('doc3.md', '# Contratto CT-9 - elenco dei deliverable\n')).toBe(
      'contract_deliverables',
    )
  })

  it('asks the PM when a new kind comes from the text alone', () => {
    expect(
      classify({ ...base, fileName: 'doc2.md', text: '# Fattura FT-9\n' }).uncertain,
    ).toContain('kind')
  })

  it('does not take a passing mention of an invoice in a contract text for an invoice', () => {
    const text = 'Contratto quadro\nIl pagamento avviene a 30 giorni dalla fattura.'
    expect(kindOf('doc4.md', text)).toBe('contract')
  })

  it('does not take «ordine del giorno» for a purchase order', () => {
    const c = classify({ ...base, fileName: 'Ordine del giorno.md' })
    expect(c.kind).toBe('generic')
  })

  it('leaves a sprint deliverable to the sprint rules, not the contract deliverables', () => {
    const c = classify({ ...base, fileName: 'Stato-deliverable-sprint-3.md' })
    expect(c.kind).toBe('backlog_export')
  })

  it('asks the PM when a bare word of the name decides a delivery kind', () => {
    expect(classify({ ...base, fileName: 'Ordine-PO-1.md' }).uncertain).toContain('kind')
    expect(classify({ ...base, fileName: 'Ordine di acquisto 45.pdf' }).uncertain).not.toContain(
      'kind',
    )
  })

  it('does not let a title that names minutes first decide a purchase order', () => {
    expect(kindOf('doc5.md', '# Verbale - ordine PO-9\n')).toBe('meeting_minutes')
    expect(kindOf('doc6.md', '# Riunione sulla fattura FT-1\n')).toBe('generic')
  })

  it('takes a contract file named for an invoice as an invoice', () => {
    expect(kindOf('Contratto-CT-7-fattura.pdf')).toBe('invoice')
  })

  it('keeps a new kind internal by default', () => {
    for (const fileName of ['Ordine-PO-1.md', 'Fattura-FT-1.md', 'Contratto-deliverable-CT-1.md']) {
      const c = classify({ ...base, fileName })
      expect(c.audience).toBe('internal')
      expect(c.audienceSource).toBe('default')
      expect(c.uncertain).toContain('audience')
    }
  })

  it('takes the kind the PM chose for a document', () => {
    const c = classify({ ...base, fileName: 'scan-001.pdf', pm: { kind: 'invoice' } })
    expect(c.kind).toBe('invoice')
    expect(c.uncertain).not.toContain('kind')
  })

  it('lets the PM open a new kind to the client', () => {
    const c = classify({ ...base, fileName: 'Ordine-PO-1.md', pm: { audience: 'client' } })
    expect(c.audience).toBe('client')
  })
})
