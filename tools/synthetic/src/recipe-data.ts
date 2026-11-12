// Synthetic data for the recipe tests: a «delivery» project with the order, invoices, contract,
// tracker, DWSI rows, standups and a transcript, and an «assessment» project with phases, gates
// and documents for the client and internal ones. Everything is invented and deterministic per
// seed. Dev-only: production sources never import this package.

import { euro, rng, SYNTHETIC_NOW, type SyntheticDocument } from './generate.ts'

const encode = (text: string) => new TextEncoder().encode(text)

/** Who a document is written for: the client documents never carry costs, rates or estimates. */
export type Audience = 'client' | 'internal'

export interface AudienceDocument extends SyntheticDocument {
  audience: Audience
}

/** A day as `YYYY-MM-DD`, moved by whole days, in UTC (never the time zone of the machine). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

const TODAY = SYNTHETIC_NOW.toISOString().slice(0, 10)

const NAMES = {
  pm: 'Paola Prova',
  dev: 'Marco Esempio',
  qa: 'Giulia Finta',
  lead: 'Luca Inventato',
  clientRef: 'Elena Cliente',
  external: 'Roberto Ospite',
} as const

// ---------------------------------------------------------------------------------------------
// Delivery

export interface OrderLine {
  position: number
  description: string
  amount: number
}

export interface PurchaseOrder {
  number: string
  date: string
  total: number
  lines: OrderLine[]
}

export interface InvoiceRecord {
  number: string
  date: string
  orderNumber: string
  /** The amount the invoice document states. */
  amount: number
  lines: Array<{ position: number; amount: number }>
}

/** A SAL request already issued: the declared values the recipe reads (sequence, period, amount). */
export interface IssuedSalRequest {
  number: number
  periodFrom: string
  periodTo: string
  amount: number
  /** Percent complete per order position at the issue. */
  progress: Record<number, number>
}

export interface ContractDeliverable {
  id: string
  title: string
  dueDate: string
  /** What really happened: the tracker and the minutes agree on it. */
  delivered: boolean
}

export type ItemType = 'story' | 'bug' | 'cr'
export type ItemState = 'Done' | 'In corso' | 'Da fare'

export interface TrackerItem {
  id: string
  type: ItemType
  title: string
  state: ItemState
  sprint: string
  /** Null: the item is not attributed to any feature (the PM decides, never the model). */
  feature: string | null
  /** Null for bugs and CRs. */
  storyPoints: number | null
  assignee: string
  /** Who or what blocks the item; null when nothing does. */
  blockedBy: string | null
  /** The priority as the tracker writes it (Azure DevOps: 1 the highest); never a severity. */
  priority: string
  /**
   * The day the item was created; null for a version read before the connector read the date
   * («non dedotto», never guessed).
   */
  created: string | null
  /** The day the tracker last changed the item; a closed item was closed that day. */
  changed: string
}

export interface Sprint {
  id: string
  name: string
  start: string
  end: string
}

export interface TrackerFeature {
  id: string
  title: string
}

/** One row of a DWSI view, keyed by the column names the connector reads. */
export type DwsiRow = Record<string, string | number | boolean | null>

export interface DeliveryRecipeProject {
  now: Date
  projectName: string
  /** The code the DWSI rows carry in `projectid`. */
  projectCode: string
  documents: AudienceDocument[]
  /** The structured twin of the order, to pass as PM parameters. */
  order: PurchaseOrder
  invoices: InvoiceRecord[]
  issuedRequests: IssuedSalRequest[]
  contract: {
    number: string
    periodFrom: string
    periodTo: string
    deliverables: ContractDeliverable[]
  }
  /** The team roster: who belongs to the team (a recipient outside it is flagged). */
  team: Array<{ name: string; role: string; email: string }>
  tracker: { sprint: Sprint; features: TrackerFeature[]; items: TrackerItem[] }
  /** Fake DWSI rows per view, ready for a fake warehouse. See `DELIVERY_DWSI_ROLES`. */
  dwsi: Record<string, DwsiRow[]>
  truth: {
    /** The invoice whose document amount differs from the warehouse: a contradiction to show. */
    invoiceContradiction: { invoiceNumber: string; documentAmount: number; dwsiAmount: number }
    /** A request number already issued: issuing it again must be refused. */
    issuedNumber: number
    /** The next free request number. */
    nextNumber: number
    /** The decision, the action items and the contradiction the transcript and standup hold. */
    decision: { fileName: string; line: string; locator: string }
    actionWithOwner: { fileName: string; line: string; owner: string; locator: string }
    actionWithoutOwner: { fileName: string; line: string; locator: string }
    externalParticipant: string
    contradiction: {
      subject: string
      sides: Array<{ fileName: string; value: string; line: string }>
    }
    /** Values that exist only in internal data: they must never reach a client document. */
    internalValues: string[]
    hasStoryPoints: boolean
    /** A blocker that is active while a standup still says «nessun blocco» (a contradiction). */
    activeBlocker: {
      itemId: string
      blockedBy: string
      fileName: string
      line: string
      locator: string
      /** The standup line that says there is no blocker. */
      denyingFileName: string
      denyingLine: string
    }
    meeting: { date: string; time: string; participants: string[] }
    /** The progress shown by the warehouse is the amount-weighted progress of the last request. */
    percentComplete: number
  }
}

/**
 * What each warehouse column the delivery data fills is, so the recipes can map them: ordered,
 * invoiced, costs and rates sit in distinct columns. The map of the categories itself is
 * confirmed by Giovanni and lives in the core.
 */
export const DELIVERY_DWSI_ROLES = {
  ordered: ['v_sales_order_all.amount', 'v_sales_order_all.quantity'],
  invoiced: ['v_sales_order_all.invoiced', 'v_invoice_all.amount', 'v_backlog_all.amountbilled'],
  costs: [
    'v_project_revenue_all.cost',
    'v_project_revenue_all.actualcost',
    'v_database_pl_all.cost_labor_ts',
    'v_database_pl_all.cost_total',
    'v_timesheet_all.laborcost_new',
  ],
  rates: ['v_timesheet_all.laborcosthh_new'],
} as const

export function generateDeliveryRecipeProject({ seed }: { seed: number }): DeliveryRecipeProject {
  const next = rng(seed)
  const between = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const name = ['Aurora', 'Borea', 'Cirrus'][between(0, 2)] as string
  const projectName = `Progetto ${name}`
  const projectCode = `P26${between(1000, 9999)}`
  const client = 'Cliente Alfa Spa'

  // Order: three positions, the total is their sum.
  const lines: OrderLine[] = [
    { position: 1, description: 'Analisi e disegno', amount: between(8, 15) * 10_000 },
    { position: 2, description: 'Sviluppo dei moduli', amount: between(20, 40) * 10_000 },
    { position: 3, description: 'Collaudo e avviamento', amount: between(5, 10) * 10_000 },
  ]
  const line1 = lines[0] as OrderLine
  const line2 = lines[1] as OrderLine
  const order: PurchaseOrder = {
    number: `OA-26-${between(100, 999)}`,
    date: '2026-03-02',
    total: lines.reduce((s, l) => s + l.amount, 0),
    lines,
  }

  // Invoices: position 1 fully, position 2 for a part.
  const part2 = Math.round((line2.amount * between(30, 60)) / 100 / 1000) * 1000
  const invoices: InvoiceRecord[] = [
    {
      number: `FT-26-${between(100, 499)}`,
      date: '2026-05-15',
      orderNumber: order.number,
      amount: line1.amount,
      lines: [{ position: 1, amount: line1.amount }],
    },
    {
      number: `FT-26-${between(500, 999)}`,
      date: '2026-09-30',
      orderNumber: order.number,
      amount: part2,
      lines: [{ position: 2, amount: part2 }],
    },
  ]
  const firstInvoice = invoices[0] as InvoiceRecord
  const secondInvoice = invoices[1] as InvoiceRecord
  const invoiced = invoices.reduce((s, i) => s + i.amount, 0)
  // The warehouse states the second invoice with another amount: two sources in disagreement.
  const dwsiDelta = between(2, 9) * 1000

  const issuedRequests: IssuedSalRequest[] = [
    {
      number: 1,
      periodFrom: '2026-03-02',
      periodTo: '2026-05-31',
      amount: line1.amount,
      progress: { 1: 100, 2: 0, 3: 0 },
    },
    {
      number: 2,
      periodFrom: '2026-06-01',
      periodTo: '2026-09-30',
      amount: part2,
      progress: { 1: 100, 2: Math.round((part2 / line2.amount) * 100), 3: 0 },
    },
  ]

  const lastProgress = (issuedRequests[issuedRequests.length - 1] as IssuedSalRequest).progress
  const percentComplete = Math.round(
    lines.reduce((sum, l) => sum + l.amount * (lastProgress[l.position] ?? 0), 0) / order.total,
  )

  const sprint: Sprint = { id: 'S14', name: 'Sprint 14', start: '2026-10-26', end: '2026-11-06' }
  const features: TrackerFeature[] = [
    { id: 'F1', title: 'Accesso e profili' },
    { id: 'F2', title: 'Reportistica mensile' },
    { id: 'F3', title: 'Notifiche di scadenza' },
  ]
  const states: ItemState[] = ['Done', 'In corso', 'Da fare']
  const item = (
    id: string,
    type: ItemType,
    title: string,
    state: ItemState,
    feature: string | null,
    storyPoints: number | null,
    assignee: string,
    sprintId: string = sprint.id,
  ): TrackerItem => ({
    id,
    type,
    title,
    state,
    sprint: sprintId,
    feature,
    storyPoints,
    assignee,
    blockedBy: null,
    priority: type === 'bug' ? '1' : '2',
    created: '2026-10-26',
    changed: '2026-11-04',
  })
  const baseItems: TrackerItem[] = [
    item('US-201', 'story', 'Accesso con credenziali aziendali', 'Done', 'F1', 5, NAMES.dev),
    item('US-202', 'story', 'Gestione dei profili', 'Done', 'F1', 3, NAMES.dev),
    item(
      'US-203',
      'story',
      'Esportazione del report mensile',
      states[between(0, 2)] as ItemState,
      'F2',
      8,
      NAMES.qa,
    ),
    item('US-204', 'story', 'Filtri per periodo', 'In corso', 'F2', 3, NAMES.dev),
    item('US-205', 'story', 'Avvisi di scadenza', 'Da fare', 'F3', 5, NAMES.qa),
    item('US-206', 'story', 'Archivio delle versioni', 'Da fare', null, 13, NAMES.dev),
    item(
      'BUG-31',
      'bug',
      'Il report non include il mese corrente',
      'In corso',
      'F2',
      null,
      NAMES.dev,
    ),
    item('BUG-32', 'bug', 'Profilo duplicato dopo la fusione', 'Done', 'F1', null, NAMES.qa),
    item(
      'CR-7',
      'cr',
      'Nuovo formato di esportazione richiesto dal cliente',
      'Da fare',
      'F2',
      null,
      NAMES.lead,
    ),
    item('US-199', 'story', 'Storia dello sprint precedente', 'Done', 'F1', 2, NAMES.dev, 'S13'),
  ]
  const blockerText = 'attesa dei dati di prova dal cliente'
  // The bug closed earlier in the sprint, with a lower priority; the change request has waited
  // since September, untouched since October, so it is open beyond any threshold of the sprint.
  // The open bug was created early in October and changed this week: old by its age, not by its
  // last change.
  const later: Record<string, Partial<TrackerItem>> = {
    'BUG-31': { blockedBy: blockerText, created: '2026-10-08' },
    'BUG-32': { priority: '2', created: '2026-10-21', changed: '2026-10-29' },
    'CR-7': { created: '2026-09-15', changed: '2026-10-12' },
    'US-199': { created: '2026-10-05', changed: '2026-10-23' },
  }
  const items: TrackerItem[] = baseItems.map((t) => ({ ...t, ...later[t.id] }))

  const deliverables: ContractDeliverable[] = [
    {
      id: 'DEL-1',
      title: 'Documento di analisi funzionale',
      dueDate: '2026-04-30',
      delivered: true,
    },
    { id: 'DEL-2', title: 'Modulo di accesso e profili', dueDate: '2026-09-30', delivered: true },
    { id: 'DEL-3', title: 'Modulo di reportistica', dueDate: '2026-11-30', delivered: false },
    { id: 'DEL-4', title: 'Manuale utente', dueDate: '2026-12-15', delivered: false },
  ]
  const contract = {
    number: `CT-26-${between(10, 99)}`,
    periodFrom: '2026-03-02',
    periodTo: '2026-12-15',
    deliverables,
  }

  // DWSI rows: ordered, invoiced, costs and rates in distinct columns.
  // Never a round figure, so it cannot be mistaken for a part of a contractual amount.
  const costMonth = between(18, 30) * 1000 + 337
  const rate = between(38, 62)
  const invoicedOfLine = (position: number) =>
    invoices
      .filter((i) => i.lines.some((l) => l.position === position))
      .reduce((s, i) => s + (i === secondInvoice ? i.amount + dwsiDelta : i.amount), 0)
  const dwsi: Record<string, DwsiRow[]> = {
    v_project: [
      {
        projectid: projectCode,
        name: projectName,
        projectmanager: NAMES.pm,
        customername: client,
        status: 'In corso',
        startdate: '2026-03-02',
        calculatedenddate: '2026-12-15',
        enddate: null,
        plannedwork: 1800,
        actualwork: 1210,
        remainingwork: 590,
        percentcomplete: percentComplete,
      },
    ],
    v_sales_order_all: lines.map((l) => ({
      projectid: projectCode,
      salesorderid: order.number,
      lineid: l.position,
      salesorderdate: order.date,
      status: 'Aperto',
      item: l.description,
      quantity: 1,
      amount: l.amount,
      invoiced: invoicedOfLine(l.position),
      closed: false,
    })),
    v_invoice_all: invoices.map((i) => ({
      projectid: projectCode,
      invoiceid: i.number,
      lineid: 1,
      status: 'Pagata',
      invoicedate: i.date,
      item: (lines[(i.lines[0] as { position: number }).position - 1] as OrderLine).description,
      amount: i === secondInvoice ? i.amount + dwsiDelta : i.amount,
      annocompetenza: 2026,
      salesorder: order.number,
      type: 'Fattura',
    })),
    v_project_revenue_all: [9, 10].map((mese) => ({
      projectid: projectCode,
      anno: 2026,
      mese,
      itemgroup: 'Sviluppo',
      cost: costMonth,
      actualcost: costMonth - 1500,
      revenue: costMonth * 2,
      actualrevenue: costMonth * 2 - 3000,
    })),
    v_database_pl_all: [9, 10].map((mese) => ({
      projectid: projectCode,
      anno: 2026,
      mese,
      revenue: costMonth * 2,
      cost_labor_ts: costMonth - 4000,
      cost_total: costMonth,
    })),
    v_backlog_all: [
      {
        projectid: projectCode,
        backlogrefperiod: '2026-10-31',
        amount: order.total - invoiced,
        amountbilled: invoiced,
        amountrecognized: invoiced + 12_000,
      },
    ],
    dw_prod_projectpercentcomplete: [
      {
        projectid: projectCode,
        period: '2026-10',
        perioddate: '2026-10-31',
        percentcomplete: percentComplete,
        periodstatus: 'Chiuso',
      },
    ],
    v_timesheet_all: [0, 1, 2, 3].map((n) => ({
      internalid: 5_000_000 + seed * 10 + n,
      projectid: projectCode,
      employee: [NAMES.dev, NAMES.qa, NAMES.dev, NAMES.lead][n] as string,
      timesheetdate: addDays('2026-10-26', n),
      casetaskevent: 'Sviluppo',
      tipoore: 'OR',
      duration: 8,
      approvalstatus: 'Approvato',
      laborcosthh_new: rate,
      laborcost_new: rate * 8,
    })),
  }

  // Documents.
  const doc = (
    fileName: string,
    mediaType: string,
    audience: Audience,
    text: string,
  ): AudienceDocument => ({ fileName, mediaType, audience, bytes: encode(text) })
  const orderText = [
    `# Ordine d'acquisto ${order.number}`,
    '',
    `Cliente: ${client}`,
    'Fornitore: Fornitore Delta Srl',
    `Data dell'ordine: ${order.date}`,
    `Riferimento: ${projectName}`,
    '',
    '| Posizione | Descrizione | Importo |',
    '| --- | --- | --- |',
    ...lines.map((l) => `| ${l.position} | ${l.description} | ${euro(l.amount)} |`),
    '',
    `Totale dell'ordine: ${euro(order.total)}.`,
    '',
  ].join('\n')
  const invoiceText = (i: InvoiceRecord) =>
    [
      `# Fattura ${i.number}`,
      '',
      `Data: ${i.date}`,
      `Cliente: ${client}`,
      `Ordine di riferimento: ${i.orderNumber}`,
      '',
      ...i.lines.map((l) => `Posizione ${l.position}: ${euro(l.amount)}`),
      '',
      `Importo fatturato: ${euro(i.amount)}.`,
      '',
    ].join('\n')
  const contractText = [
    `# Contratto ${contract.number} - elenco dei deliverable`,
    '',
    `Periodo del contratto: dal ${contract.periodFrom} al ${contract.periodTo}.`,
    '',
    '| Id | Deliverable | Scadenza |',
    '| --- | --- | --- |',
    ...deliverables.map((d) => `| ${d.id} | ${d.title} | ${d.dueDate} |`),
    '',
  ].join('\n')
  const teamText = [
    `# Consuntivo interno del team - ${projectName}`,
    '',
    'Documento interno: non va al cliente.',
    '',
    `Costo del periodo: ${euro(costMonth)}.`,
    `Tariffa oraria media: ${rate} € all'ora.`,
    `Stima a finire: ${euro(between(15, 25) * 1000)}.`,
    '',
  ].join('\n')
  const trackerCsv = [
    'id,tipo,titolo,stato,sprint,feature,story_point,assegnatario',
    ...items.map((t) =>
      [
        t.id,
        t.type,
        t.title,
        t.state,
        t.sprint,
        t.feature ?? '',
        t.storyPoints ?? '',
        t.assignee,
      ].join(','),
    ),
    '',
  ].join('\n')

  // Standups (internal) and the transcript, with the locators the tests quote.
  const standupDoc = (day: string, status: string) =>
    [
      `# Standup del ${day} - ${projectName}`,
      '',
      `Partecipanti: ${NAMES.pm}, ${NAMES.dev}, ${NAMES.qa}.`,
      status,
      '',
    ].join('\n')
  const standupLine = 'Il modulo di reportistica sarà consegnato al cliente il 27 novembre 2026.'
  const standup1 = standupDoc(addDays(TODAY, -2), `${NAMES.qa}: nessun problema da segnalare.`)
  const denyLine = `${NAMES.dev}: avanzo sui filtri per periodo, nessun blocco.`
  const standup2 = standupDoc(addDays(TODAY, -1), `${NAMES.pm}: ${standupLine}\n${denyLine}`)

  const decisionLine = `${NAMES.lead}: decidiamo di consegnare il modulo di reportistica il 4 dicembre 2026.`
  const actionOwnerLine = `${NAMES.pm}: ${NAMES.dev} prepara il piano di test entro il 20 novembre 2026.`
  const actionNoOwnerLine = `${NAMES.qa}: bisogna aggiornare il registro dei rischi, ma non abbiamo detto chi.`
  const blockerLine = `${NAMES.dev}: il difetto BUG-31 è bloccato da ${blockerText}.`
  const meeting = {
    date: TODAY,
    time: '10:30',
    participants: [NAMES.pm, NAMES.lead, NAMES.qa, NAMES.clientRef, NAMES.external],
  }
  const cues = [
    `${NAMES.pm}: Buongiorno a tutti, iniziamo la riunione di avanzamento di ${projectName}.`,
    `${NAMES.clientRef}: Per noi la data della consegna del modulo di reportistica è importante.`,
    decisionLine,
    actionOwnerLine,
    actionNoOwnerLine,
    blockerLine,
    `${NAMES.external}: Io partecipo come ospite, la questione dei permessi resta aperta.`,
  ]
  const stamp = (n: number, offset: number) =>
    `00:00:${String(n * 10 + offset).padStart(2, '0')}.000`
  const vtt = [
    'WEBVTT',
    '',
    'NOTE',
    `Data: ${meeting.date}`,
    `Ora: ${meeting.time}`,
    `Partecipanti: ${meeting.participants.join(', ')}`,
    '',
    ...cues.flatMap((c, n) => [String(n + 1), `${stamp(n, 1)} --> ${stamp(n, 9)}`, c, '']),
  ].join('\n')
  const locatorOf = (n: number) => `${n + 1} (${stamp(n, 1).slice(0, 8)})`

  const files = {
    order: `Ordine-${order.number}.md`,
    inv1: `Fattura-${firstInvoice.number}.md`,
    inv2: `Fattura-${secondInvoice.number}.md`,
    contract: `Contratto-deliverable-${contract.number}.md`,
    team: `Consuntivo-team-interno-${name}-${TODAY}.md`,
    tracker: `Backlog-${name}-${TODAY}.csv`,
    standup1: `Standup-${name}-${addDays(TODAY, -2)}.md`,
    standup2: `Standup-${name}-${addDays(TODAY, -1)}.md`,
    transcript: `Trascrizione-${name}-${TODAY}.vtt`,
  }

  const documents: AudienceDocument[] = [
    doc(files.order, 'text/markdown', 'client', orderText),
    doc(files.inv1, 'text/markdown', 'client', invoiceText(firstInvoice)),
    doc(files.inv2, 'text/markdown', 'client', invoiceText(secondInvoice)),
    doc(files.contract, 'text/markdown', 'client', contractText),
    doc(files.team, 'text/markdown', 'internal', teamText),
    doc(files.tracker, 'text/csv', 'client', trackerCsv),
    doc(files.standup1, 'text/markdown', 'internal', standup1),
    doc(files.standup2, 'text/markdown', 'internal', standup2),
    doc(files.transcript, 'text/vtt', 'internal', vtt),
  ]

  return {
    now: SYNTHETIC_NOW,
    projectName,
    projectCode,
    documents,
    order,
    invoices,
    issuedRequests,
    contract,
    team: [
      { name: NAMES.pm, role: 'PM', email: 'paola.prova@example.invalid' },
      { name: NAMES.dev, role: 'sviluppo', email: 'marco.esempio@example.invalid' },
      { name: NAMES.qa, role: 'qualità', email: 'giulia.finta@example.invalid' },
      { name: NAMES.lead, role: 'responsabile tecnico', email: 'luca.inventato@example.invalid' },
    ],
    tracker: { sprint, features, items },
    dwsi,
    truth: {
      invoiceContradiction: {
        invoiceNumber: secondInvoice.number,
        documentAmount: secondInvoice.amount,
        dwsiAmount: secondInvoice.amount + dwsiDelta,
      },
      issuedNumber: 2,
      nextNumber: 3,
      decision: { fileName: files.transcript, line: decisionLine, locator: locatorOf(2) },
      actionWithOwner: {
        fileName: files.transcript,
        line: actionOwnerLine,
        owner: NAMES.dev,
        locator: locatorOf(3),
      },
      actionWithoutOwner: {
        fileName: files.transcript,
        line: actionNoOwnerLine,
        locator: locatorOf(4),
      },
      externalParticipant: NAMES.external,
      activeBlocker: {
        itemId: 'BUG-31',
        blockedBy: blockerText,
        fileName: files.transcript,
        line: blockerLine,
        locator: locatorOf(5),
        denyingFileName: files.standup2,
        denyingLine: denyLine,
      },
      meeting,
      percentComplete,
      contradiction: {
        subject: 'Data di consegna del modulo di reportistica',
        sides: [
          {
            fileName: files.standup2,
            value: '27 novembre 2026',
            line: `${NAMES.pm}: ${standupLine}`,
          },
          { fileName: files.transcript, value: '4 dicembre 2026', line: decisionLine },
        ],
      },
      internalValues: [euro(costMonth), `${rate} €`],
      hasStoryPoints: items.some((t) => t.storyPoints !== null),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Assessment

export interface AssessmentGate {
  id: string
  question: string
  criteria: string[]
  /** Always null in the data: the outcome is only ever proposed, and the PM decides. */
  decidedOutcome: null
}

export interface AssessmentPhase {
  id: string
  name: string
  start: string
  end: string
  gate: AssessmentGate
  /** The results of the phase, each with the document (file name) that holds it. */
  results: Array<{ id: string; statement: string; source: string; sourceLine: string }>
}

export interface AssessmentProject {
  now: Date
  projectName: string
  phases: AssessmentPhase[]
  documents: AudienceDocument[]
  truth: {
    /** Internal values (estimates, costs) that must never reach a client version. */
    internalValues: string[]
    internalFileNames: string[]
  }
}

export function generateAssessmentProject({ seed }: { seed: number }): AssessmentProject {
  const next = rng(seed)
  const between = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1))
  const name = ['Orione', 'Pegaso', 'Lira'][between(0, 2)] as string
  const projectName = `Assessment ${name}`
  const apps = between(12, 30)
  const days = between(20, 40)
  const effortDays = between(60, 140)
  const cost = effortDays * between(35, 55) * 10 + 370

  const phase = (
    id: string,
    phaseName: string,
    start: string,
    end: string,
    question: string,
    criteria: string[],
    results: AssessmentPhase['results'],
  ): AssessmentPhase => ({
    id,
    name: phaseName,
    start,
    end,
    gate: { id: `G-${id}`, question, criteria, decidedOutcome: null },
    results,
  })
  const phases: AssessmentPhase[] = [
    phase(
      'F1',
      'Raccolta e inventario',
      '2026-09-07',
      '2026-09-30',
      "L'inventario è abbastanza completo per passare all'analisi?",
      ['Tutti i sistemi del perimetro sono elencati', 'Ogni sistema ha un referente'],
      [
        {
          id: 'R1',
          statement: `Sono stati censiti ${apps} applicativi nel perimetro`,
          source: `Inventario-applicativi-${name}.md`,
          sourceLine: `Applicativi censiti: ${apps}.`,
        },
      ],
    ),
    phase(
      'F2',
      'Analisi',
      '2026-10-01',
      '2026-10-30',
      'Le criticità emerse bastano a proporre un piano?',
      ['Le criticità sono classificate', 'Ogni criticità ha una fonte'],
      [
        {
          id: 'R2',
          statement: 'Tre criticità sono classificate come alte',
          source: `Report-analisi-${name}.md`,
          sourceLine: 'Criticità alte: 3.',
        },
      ],
    ),
    phase(
      'F3',
      'Proposta',
      '2026-11-02',
      '2026-11-27',
      'Il piano proposto può essere presentato al cliente?',
      ['Il piano ha tappe e responsabilità', 'Il cliente ha validato le priorità'],
      [],
    ),
  ]

  const doc = (fileName: string, audience: Audience, lines: string[]): AudienceDocument => ({
    fileName,
    mediaType: 'text/markdown',
    audience,
    bytes: encode(lines.join('\n')),
  })
  const documents: AudienceDocument[] = [
    doc(`Inventario-applicativi-${name}.md`, 'client', [
      `# Inventario degli applicativi - ${projectName}`,
      '',
      `Applicativi censiti: ${apps}.`,
      '',
    ]),
    doc(`Report-analisi-${name}.md`, 'client', [
      `# Report della fase di analisi - ${projectName}`,
      '',
      'Criticità alte: 3.',
      'Criticità medie: 7.',
      '',
    ]),
    doc(`Verbale-kickoff-${name}.md`, 'client', [
      `# Verbale di avvio - ${projectName}`,
      '',
      `Partecipanti: ${NAMES.pm}, ${NAMES.clientRef}.`,
      'Decisione: il perimetro comprende i sistemi della sede centrale.',
      '',
    ]),
    doc(`Piano-fasi-gate-${name}.md`, 'client', [
      `# Fasi e gate - ${projectName}`,
      '',
      ...phases.flatMap((p) => [
        `## ${p.name} (${p.start} - ${p.end})`,
        `Gate: ${p.gate.question}`,
        ...p.gate.criteria.map((c) => `- ${c}`),
        '',
      ]),
    ]),
    doc(`Stima-interna-${name}.md`, 'internal', [
      `# Stima interna - ${projectName}`,
      '',
      'Documento interno: non va al cliente.',
      '',
      `Stima dell'impegno: ${effortDays} giornate.`,
      `Costo previsto: ${euro(cost)}.`,
      `Durata stimata dell'analisi: ${days} giorni.`,
      '',
    ]),
    doc(`Note-interne-${name}.md`, 'internal', [
      `# Note interne - ${projectName}`,
      '',
      `${NAMES.pm}: il cliente è sensibile sul perimetro, margine di trattativa ridotto.`,
      '',
    ]),
  ]

  return {
    now: SYNTHETIC_NOW,
    projectName,
    phases,
    documents,
    truth: {
      internalValues: [`${effortDays} giornate`, euro(cost), `${days} giorni`],
      internalFileNames: documents.filter((x) => x.audience === 'internal').map((x) => x.fileName),
    },
  }
}
