import {
  type BlockRemark,
  blocksReadForClient,
  canonicalHash,
  canonicalJson,
  checkParameterValues,
  type DataCategory,
  DEFAULT_CLIENT_CATEGORIES,
  type DocumentSourceRef,
  DomainError,
  DWSI_VALUE_KINDS,
  DWSI_VIEW_KEYS,
  type EvidenceAudience,
  type FactAudience,
  type FieldValue,
  type FreshnessPolicy,
  type FreshnessThresholds,
  factKeyMatches,
  factPolicy,
  factSourceRemoved,
  type GatheredBlock,
  type GatheredContradiction,
  type GatheredData,
  type GatheredNote,
  type GatheredRow,
  groupWorkItems,
  hasClientVersion,
  INPUT_SNAPSHOT_SCHEMA,
  type InputSnapshot,
  isInternalOnly,
  isSystemDataSource,
  type Lang,
  type Locator,
  MAX_BLOCK_ROWS,
  MAX_TRACKER_ITEMS_SCANNED,
  matchesTrackerFilter,
  notDeducedSections,
  type ParameterValue,
  type ParameterValues,
  type ProjectId,
  parameterTitleTexts,
  parseCalendarDay,
  periodsOf,
  periodText,
  type Recipe,
  type RecipeBlock,
  type RecipeDataReader,
  type RecipeEvidenceView,
  type RecipeFactView,
  type RecipeQuery,
  type RecipeRead,
  type RecipeSystemView,
  recipeDictionary,
  recipeText,
  romeDateString,
  type SnapshotRender,
  type SourceFreshness,
  type SourceId,
  type RecipeSourceKind as SourceKind,
  sortWorkItems,
  sourceFreshnessOf,
  systemLeftUndated,
  type TrackerFilter,
  type TrackerSourceView,
  tightenFreshness,
  trackerDataAsOf,
  typedRowsRead,
  type WorkItem,
  workItemLabel,
  workItemOf,
} from '@octobrief/domain/recipe'
import { trackerSourceStatus } from '../ask/tracker-tool.ts'

// The gathering of a recipe: its declarative queries run by the code, through the storage the
// tools of the model read, as deterministic functions. No model, no model runner: every value
// read is cited (a work item, a row of a system, a fact, a place of a piece of evidence, a
// parameter), dated at its source and written in the read log; what a source removed is left
// out; contradictions are kept with both sides, and a correction of the PM wins.

export interface GatherDeps<Tx> {
  projectId: ProjectId
  reader: RecipeDataReader<Tx>
  /** Runs `fn` in one transaction scoped to the user the run is for (row-level security). */
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /** The reference time of the run: the tracker is read as of it, ages are judged at it. */
  now: Date
  /** The fingerprint of the recipe version the run uses. */
  recipeHash: string
  /** The fingerprint of the configuration of the recipe in the project; null when none. */
  settingsHash: string | null
  /** The alias of the model the run will write with; null when none is chosen yet. */
  modelAlias: string | null
  /** What the files of the run are made with: the configuration and the template found now. */
  render?: SnapshotRender
  /** The categories the client version admits (the Admin's policy); the default when absent. */
  clientCategories?: readonly DataCategory[]
}

export interface GatherResult {
  gathered: GatheredData
  snapshot: InputSnapshot
}

type RowsBlock = Extract<RecipeBlock, { kind: 'data_table' | 'data_list' }>

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())
const day = (d: Date | null): FieldValue => (d === null ? null : { day: romeDateString(d) })
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Equal ignoring case, accents and spacing, as the tracker filters compare. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** A value of the data warehouse as a recipe reads it: decimals as numbers, dates as days. */
function systemValue(view: string, column: string, raw: unknown): FieldValue {
  const kinds = Object.hasOwn(DWSI_VALUE_KINDS, view) ? DWSI_VALUE_KINDS[view] : undefined
  const kind = kinds && Object.hasOwn(kinds, column) ? kinds[column] : undefined
  if (raw === null || raw === undefined) return null
  if (kind === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    // A decimal written by the database: a dot before the decimals, never a thousands separator.
    if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw.trim())
    return null
  }
  if (kind === 'day') {
    if (typeof raw !== 'string') return null
    const text = raw.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parseCalendarDay(text) ? { day: text } : null
    // An instant: its day in Italy. The warehouse writes its timestamps in UTC, without a zone.
    const m =
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(
        text,
      )
    if (!m) return null
    const at = new Date(`${m[1]}T${m[2]}${m[3] ?? 'Z'}`)
    return Number.isNaN(at.getTime()) ? null : { day: romeDateString(at) }
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  return null
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/**
 * Whether a value of a row equals the one a recipe asks: as numbers when both are written as
 * plain numbers without leading zeros (an integer code given as a number or as text), else as
 * texts, ignoring case, accents and spacing.
 */
function sameValue(value: FieldValue | undefined, wanted: string | number): boolean {
  if (value === null || value === undefined || typeof value === 'object') return false
  const a = String(value).trim()
  const b = String(wanted).trim()
  // A code with leading zeros («007») is a text, not the number 7.
  const numeric = (t: string) => PLAIN_NUMBER.test(t) && !/^-?0\d/.test(t)
  if (numeric(a) && numeric(b)) return Number(a) === Number(b)
  return fold(a) === fold(b)
}

/** The fields of a work item a recipe reads. */
function workItemValues(item: WorkItem): Record<string, FieldValue> {
  return {
    id: item.externalId,
    summary: item.summary,
    type: item.type,
    state: item.state,
    sprint: item.sprint,
    iteration: item.iteration,
    area: item.area,
    assignee: item.assignee,
    story_points: item.storyPoints,
    priority: item.priority,
    created: day(item.created),
    changed: day(item.changed),
    closed: day(item.closed),
    due: item.due === null ? null : { day: item.due },
    parent: item.parent,
    tags: item.tags,
  }
}

/** System data its system did not date (an export read by a connector of a system). */
const undatedAtSource = (e: RecipeEvidenceView) =>
  systemLeftUndated({
    sourceKind: e.sourceKind,
    originSource: e.originSource,
    dateSource: e.dateSource,
  })

/**
 * Rows of the warehouse whose values the snapshot keeps: beyond, it keeps their identity and the
 * fingerprint of their values only, so a snapshot stays small.
 */
export const MAX_SNAPSHOT_ROW_VALUES = 2_000

const everyField = (values: Record<string, FieldValue>, ref: DocumentSourceRef) =>
  Object.fromEntries(Object.keys(values).map((k) => [k, ref]))

class Gathering<Tx> {
  private readonly notes = new Map<string, GatheredNote>()
  private readonly readLog: RecipeRead[] = []
  private readonly freshness = new Map<string, SourceFreshness>()
  private readonly contradictions = new Map<string, GatheredContradiction>()
  private readonly contested = new Set<string>()
  private readonly evidenceAudience: Record<string, EvidenceAudience> = {}
  private readonly factAudience: Record<string, FactAudience> = {}
  private readonly sourceKinds: Record<string, SourceKind> = {}
  private readonly evidencePolicy: Record<
    string,
    { policy: FreshnessPolicy; sourceKind: SourceKind }
  > = {}
  private readonly factPolicies: Record<string, { policy: FreshnessPolicy }> = {}
  private readonly snapEvidence = new Map<string, InputSnapshot['evidence'][number]>()
  private readonly snapTracker = new Map<string, InputSnapshot['tracker'][number]>()
  private readonly snapRows = new Map<string, InputSnapshot['systemRows'][number]>()
  private readonly snapFacts = new Map<string, InputSnapshot['facts'][number]>()
  private catalog: Map<string, RecipeEvidenceView> | null = null
  private trackers: TrackerSourceView[] | null = null
  private items: WorkItem[] | null | 'too_many' = null
  private itemIndex: Map<string, WorkItem> | null = null
  private readonly views = new Map<string, RecipeSystemView[]>()
  private readonly factsOf = new Map<string, RecipeFactView[]>()

  private readonly recipe: Recipe
  private readonly params: ParameterValues
  private readonly lang: Lang
  private readonly thresholds: FreshnessThresholds
  private readonly deps: GatherDeps<Tx>
  private readonly tx: Tx

  constructor(
    recipe: Recipe,
    params: ParameterValues,
    lang: Lang,
    thresholds: FreshnessThresholds,
    deps: GatherDeps<Tx>,
    tx: Tx,
  ) {
    this.recipe = recipe
    this.params = params
    this.lang = lang
    this.thresholds = thresholds
    this.deps = deps
    this.tx = tx
  }

  // Notes, reads, freshness -------------------------------------------------------------------

  private note(ref: DocumentSourceRef, label: string, dataAsOf: string | null): void {
    const key = canonicalJson(ref)
    if (!this.notes.has(key)) this.notes.set(key, { ref, label, dataAsOf })
  }

  private read(ref: DocumentSourceRef, values: Record<string, FieldValue>): void {
    this.readLog.push({ ref, values })
  }

  /** The thresholds of a source kind: the project's, made stricter by the recipe. */
  private thresholdsFor(kind: SourceKind | null): FreshnessThresholds {
    let t = tightenFreshness(this.thresholds)
    for (const p of this.recipe.prerequisites) {
      if (p.kind !== 'source' || p.freshness === undefined || kind === null) continue
      if (!p.sourceKinds.includes(kind)) continue
      t = {
        warnAfterHours: Math.min(t.warnAfterHours, p.freshness.warnAfterHours),
        stopAfterHours: Math.min(t.stopAfterHours, p.freshness.stopAfterHours),
      }
    }
    return t
  }

  private fresh(
    source: string,
    policy: FreshnessPolicy,
    kind: SourceKind | null,
    dataAsOf: Date | null,
    extra: Partial<SourceFreshness> = {},
  ): void {
    const known = this.freshness.get(source)
    // A source read twice is as old as its oldest data, unknown if any of it is.
    if (
      known &&
      (known.dataAsOf === null || (dataAsOf && known.dataAsOf <= dataAsOf.toISOString()))
    )
      return
    const level =
      dataAsOf === null
        ? 'unknown'
        : sourceFreshnessOf(dataAsOf, this.deps.now, this.thresholdsFor(kind), policy).level
    this.freshness.set(source, { source, policy, level, dataAsOf: iso(dataAsOf), ...extra })
  }

  // The values of the parameters ----------------------------------------------------------------

  /** A literal of a filter or the value of a parameter; null for an optional one skipped. */
  private filterValue(v: string | { parameter: string }): string | null {
    if (typeof v === 'string') return v
    const p = Object.hasOwn(this.params, v.parameter) ? this.params[v.parameter] : undefined
    if (p === undefined) return null
    if (p.type === 'text' || p.type === 'choice') return p.value
    return null
  }

  private label(parameter: string): string {
    return this.recipe.parameters.find((p) => p.id === parameter)?.label ?? parameter
  }

  /** The values of a list filter; a skipped optional parameter drops out, with a remark. */
  private filterList(
    list: ReadonlyArray<string | { parameter: string }> | undefined,
    remarks: BlockRemark[],
  ) {
    if (list === undefined) return undefined
    const values: string[] = []
    for (const v of list) {
      const table = typeof v === 'object' ? this.params[v.parameter] : undefined
      // A list the PM gives is a table of one text column: every row is a value.
      if (table?.type === 'rows') {
        values.push(...table.rows.flatMap((r) => Object.values(r).map(String)))
        continue
      }
      const value = this.filterValue(v)
      if (value !== null) values.push(value)
      else if (typeof v === 'object') {
        remarks.push({ code: 'filter_dropped', parameter: this.label(v.parameter) })
      }
    }
    return values.length === 0 ? undefined : values
  }

  private dayOf(v: string | { parameter: string } | undefined): string | undefined {
    if (v === undefined) return undefined
    if (typeof v === 'string') return v
    const p = Object.hasOwn(this.params, v.parameter) ? this.params[v.parameter] : undefined
    return p?.type === 'date' ? p.day : undefined
  }

  private period(ref: { parameter: string } | undefined): { from: string; to: string } | null {
    if (ref === undefined) return null
    const p = Object.hasOwn(this.params, ref.parameter) ? this.params[ref.parameter] : undefined
    return p?.type === 'period' ? { from: p.from, to: p.to } : null
  }

  noteParameters(): void {
    for (const p of this.recipe.parameters) {
      if (!Object.hasOwn(this.params, p.id)) continue
      const v = this.params[p.id] as ParameterValue
      // A table of the PM is read row by row, cited with the documents it was copied from.
      if (p.type === 'rows' && v.type === 'rows') {
        const ids = this.copiedFrom(p.evidence)
        const document = this.recipe.parameters.find((x) => x.id === p.evidence)?.label ?? ''
        for (const row of typedRowsRead(p.id, p.columns, v.rows, ids)) {
          // Each place a row cites, with the values of the columns that cite it.
          const byRef = new Map<
            string,
            { ref: DocumentSourceRef; values: Record<string, FieldValue> }
          >()
          for (const [field, ref] of Object.entries(row.refs)) {
            const key = canonicalJson(ref)
            const at = byRef.get(key) ?? { ref, values: {} }
            at.values[field] = row.values[field] as FieldValue
            byRef.set(key, at)
          }
          for (const { ref, values } of byRef.values()) {
            const label =
              ref.kind === 'parameter' && ref.evidenceIds !== undefined
                ? recipeText(
                    'gathering',
                    'note_parameter_from_documents',
                    { name: p.label, document },
                    this.lang,
                  )
                : recipeText('gathering', 'note_parameter', { name: p.label }, this.lang)
            this.note(ref, label, null)
            this.read(ref, values)
          }
        }
        continue
      }
      const ref: DocumentSourceRef = { kind: 'parameter', parameterId: p.id }
      this.note(ref, recipeText('gathering', 'note_parameter', { name: p.label }, this.lang), null)
      this.read(ref, { value: this.parameterField(p.id, v) })
    }
  }

  /** The documents the PM chose in an evidence parameter, which a table was copied from. */
  private copiedFrom(evidence: string | undefined): string[] {
    if (evidence === undefined || !Object.hasOwn(this.params, evidence)) return []
    const v = this.params[evidence] as ParameterValue
    return v.type === 'evidence_selection' ? [...v.evidenceIds] : []
  }

  private parameterField(id: string, v: ParameterValue): FieldValue {
    switch (v.type) {
      case 'text':
        return v.value
      case 'date':
        return { day: v.day }
      case 'period':
        return periodText(v.from, v.to, this.lang)
      case 'choice': {
        const p = this.recipe.parameters.find((x) => x.id === id)
        return p?.type === 'choice'
          ? (p.options.find((o) => o.value === v.value)?.label ?? null)
          : null
      }
      case 'number':
        return v.value
      case 'evidence_selection':
        return [...v.evidenceIds]
      case 'work_item_selection':
        return v.items.map((i) => i.id)
      case 'rows':
        return null
    }
  }

  // Evidence -------------------------------------------------------------------------------------

  async evidence(): Promise<Map<string, RecipeEvidenceView>> {
    if (this.catalog === null) {
      const all = await this.deps.reader.evidence(this.tx, this.deps.projectId)
      this.catalog = new Map(all.map((e) => [e.id, e]))
    }
    return this.catalog
  }

  private noteEvidence(e: RecipeEvidenceView, ref: DocumentSourceRef): void {
    const undated = systemLeftUndated({
      sourceKind: e.sourceKind,
      originSource: e.originSource,
      dateSource: e.dateSource,
    })
    const byAcquisition = e.dateSource === 'acquisition' && !undated
    const label = byAcquisition
      ? recipeText('gathering', 'dated_by_acquisition', { title: e.title }, this.lang)
      : e.title
    const dataAsOf = undated ? null : e.date
    this.note(ref, label, iso(dataAsOf))
    this.fresh(`evidence:${e.id}`, e.policy, e.sourceKind, dataAsOf, {
      ...(byAcquisition ? { datedByAcquisition: true as const } : {}),
    })
    this.knowEvidence(e)
  }

  private knowEvidence(e: RecipeEvidenceView): void {
    this.evidencePolicy[e.id] = { policy: e.policy, sourceKind: e.sourceKind }
    this.snapEvidence.set(e.id, {
      id: e.id,
      contentHash: e.contentHash,
      classificationVersion: e.classificationVersion,
      title: e.title,
      date: e.date.toISOString(),
      dateSource: e.dateSource,
    })
    // Without a classification, a piece of evidence is an untyped internal document.
    this.evidenceAudience[e.id] = {
      kind: e.kind ?? 'generic',
      audience: e.audience ?? 'internal',
      fromSystem: isSystemDataSource(e.sourceKind),
      title: e.title,
    }
  }

  private async evidenceRows(chosen: readonly RecipeEvidenceView[]): Promise<GatheredRow[]> {
    const locators = await this.deps.reader.firstLocators(
      this.tx,
      this.deps.projectId,
      chosen.map((e) => e.id),
    )
    const dict = recipeDictionary(this.lang)
    return chosen.map((e) => {
      const values: Record<string, FieldValue> = {
        title: e.title,
        // System data its system did not date: its date is «non dedotto», never the read.
        date: undatedAtSource(e) ? null : { day: romeDateString(e.date) },
        kind: e.kind === null ? null : dict.documentKinds[e.kind],
      }
      const locator: Locator | undefined = locators.get(e.id)
      // A piece of evidence without a text has no place to cite: its row is «non dedotto».
      if (locator === undefined) {
        this.knowEvidence(e)
        return { values, refs: {} }
      }
      const ref: DocumentSourceRef = { kind: 'evidence', evidenceId: e.id, locator }
      this.noteEvidence(e, ref)
      this.read(ref, values)
      return { values, refs: everyField(values, ref) }
    })
  }

  private async evidenceBlock(
    q: Extract<RecipeQuery, { kind: 'evidence' }>,
  ): Promise<GatheredBlock> {
    const catalog = await this.evidence()
    const period = this.period(q.period)
    // A period the PM skipped never widens the block to every date.
    if (q.period !== undefined && period === null) {
      return { status: 'not_deduced', reason: 'parameter_skipped' }
    }
    const chosen = [...catalog.values()]
      .filter(
        (e) =>
          e.removedAt === null &&
          e.kind !== null &&
          q.documentKinds.includes(e.kind) &&
          (q.audience === undefined || e.audience === q.audience) &&
          // Without a date at its source, a piece of evidence is in no period.
          (period === null ||
            (!undatedAtSource(e) &&
              romeDateString(e.date) >= period.from &&
              romeDateString(e.date) <= period.to)),
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime() || byId(a, b))
    if (chosen.length > MAX_BLOCK_ROWS) return { status: 'not_deduced', reason: 'too_many_rows' }
    return { status: 'read', rows: await this.evidenceRows(chosen), totals: [] }
  }

  // Tracker ---------------------------------------------------------------------------------------

  private async trackerSources(): Promise<TrackerSourceView[]> {
    this.trackers ??= await this.deps.reader.trackerSources(this.tx, this.deps.projectId)
    return this.trackers
  }

  /** The readable trackers: synced to the end, with the history of the reference time. */
  private async readable(): Promise<TrackerSourceView[]> {
    const all = await this.trackerSources()
    return all.filter((s) => trackerSourceStatus(s, this.deps.now) === 'ok')
  }

  /**
   * The trackers a block reads, recorded in the snapshot and the freshness of the run: a
   * readable one at the date of its data, one not readable of unknown age (the gates flag it
   * wherever its counts are cited). Only these: a tracker no block reads is never recorded.
   */
  private noteTrackers(sources: readonly TrackerSourceView[]): void {
    for (const s of sources) {
      this.sourceKinds[s.sourceId] = s.kind
      if (trackerSourceStatus(s, this.deps.now) !== 'ok') {
        this.fresh(`tracker:${s.sourceId}`, 'system', s.kind, null)
        continue
      }
      const dataAsOf = trackerDataAsOf(s)
      this.snapTracker.set(s.sourceId, {
        sourceId: s.sourceId,
        at: this.deps.now.toISOString(),
        dataAsOf: iso(dataAsOf),
      })
      this.fresh(`tracker:${s.sourceId}`, 'system', s.kind, dataAsOf)
    }
  }

  /** What the PM is told of the trackers of the project that could not be read. */
  private async unreadable(among?: readonly TrackerSourceView[]): Promise<BlockRemark[]> {
    const all = among ?? (await this.trackerSources())
    return all
      .filter((s) => trackerSourceStatus(s, this.deps.now) !== 'ok')
      .map((s) => ({ code: 'source_not_synced', source: s.label }))
  }

  /**
   * The trackers a tracker query counts: in a run with a version for the client only those the
   * PM said hold the client's data (an internal backlog is never counted in a client document,
   * and the PM is told which were left out); every tracker otherwise.
   */
  private async countedTrackers(forClient: boolean): Promise<{
    counted: TrackerSourceView[]
    leftOut: BlockRemark[]
  }> {
    const all = await this.trackerSources()
    if (!forClient || !hasClientVersion(this.recipe, this.params)) {
      return { counted: all, leftOut: [] }
    }
    return {
      counted: all.filter((s) => s.audience === 'client'),
      leftOut: all
        .filter((s) => s.audience !== 'client')
        .map((s) => ({ code: 'internal_source_left_out', source: s.label })),
    }
  }

  /**
   * The work items of every readable tracker, read once for the run; a block keeps those of the
   * trackers it counts, and records only those (`noteTrackers`).
   */
  private async workItems(): Promise<WorkItem[] | 'too_many'> {
    if (this.items === null) {
      const ok = await this.readable()
      const stored = await this.deps.reader.trackerItems(this.tx, this.deps.projectId, {
        sourceIds: ok.map((s) => s.sourceId),
        at: this.deps.now,
        limit: MAX_TRACKER_ITEMS_SCANNED + 1,
      })
      this.items =
        stored.length > MAX_TRACKER_ITEMS_SCANNED
          ? 'too_many'
          : stored.filter((s) => ok.some((o) => o.sourceId === s.sourceId)).map(workItemOf)
    }
    return this.items
  }

  /** A work item read for the run, by its tracker and id. */
  private itemOf(sourceId: string, id: string): WorkItem | undefined {
    if (this.itemIndex === null) {
      this.itemIndex = new Map(
        (Array.isArray(this.items) ? this.items : []).map((i) => [
          canonicalJson([i.sourceId, i.externalId]),
          i,
        ]),
      )
    }
    return this.itemIndex.get(canonicalJson([sourceId, id]))
  }

  /** A work item another one names (its parent, its feature), as the document shows it. */
  private labelOf(sourceId: string, id: string): string {
    return workItemLabel(id, this.itemOf(sourceId, id), this.lang)
  }

  private itemRow(item: WorkItem, source: TrackerSourceView): GatheredRow {
    const ref: DocumentSourceRef = {
      kind: 'work_item',
      sourceId: item.sourceId,
      id: item.externalId,
    }
    const values = workItemValues(item)
    // The parent by its title, never only by a number the reader cannot place.
    if (item.parent !== null) values.parent = this.labelOf(item.sourceId, item.parent)
    this.note(
      ref,
      recipeText(
        'gathering',
        'note_work_item',
        { source: source.label, id: item.externalId },
        this.lang,
      ),
      iso(trackerDataAsOf(source)),
    )
    this.read(ref, values)
    return { values, refs: everyField(values, ref) }
  }

  /**
   * The filter of a tracker query with the values of the parameters, and what was dropped; null
   * when a date or a period the PM skipped would widen it to every date.
   */
  private trackerFilter(
    q: Extract<RecipeQuery, { kind: 'tracker' }>,
    remarks: BlockRemark[],
  ): TrackerFilter | null {
    const f = q.filter
    const out: TrackerFilter = {}
    const lists = {
      types: this.filterList(f.types, remarks),
      excludedTypes: this.filterList(f.excludedTypes, remarks),
      states: this.filterList(f.states, remarks),
      sprints: this.filterList(f.sprints, remarks),
      iterations: this.filterList(f.iterations, remarks),
      areas: this.filterList(f.areas, remarks),
      assignees: this.filterList(f.assignees, remarks),
    }
    for (const [k, v] of Object.entries(lists)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v
    }
    if (f.undated !== undefined) out.undated = f.undated
    if (f.dates !== undefined) {
      const period = this.period(f.dates.period)
      const from = period?.from ?? this.dayOf(f.dates.from)
      const to = period?.to ?? this.dayOf(f.dates.to)
      const skipped =
        (f.dates.period !== undefined && period === null) ||
        (f.dates.from !== undefined && from === undefined) ||
        (f.dates.to !== undefined && to === undefined)
      if (skipped) return null
      if (from !== undefined || to !== undefined) {
        out.dates = {
          field: f.dates.field,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }
      }
    }
    return out
  }

  private async trackerBlock(
    blockId: string,
    q: Extract<RecipeQuery, { kind: 'tracker' }>,
    forClient: boolean,
  ): Promise<GatheredBlock> {
    if ((await this.trackerSources()).length === 0) {
      return { status: 'not_deduced', reason: 'no_source' }
    }
    const { counted: all, leftOut } = await this.countedTrackers(forClient)
    if (all.length === 0) {
      return { status: 'not_deduced', reason: 'no_client_source', remarks: leftOut }
    }
    const remarks: BlockRemark[] = [...leftOut]
    const filter = this.trackerFilter(q, remarks)
    if (filter === null) return { status: 'not_deduced', reason: 'parameter_skipped' }
    this.noteTrackers(all)
    const readable = await this.readable()
    const ok = readable.filter((s) => all.includes(s))
    remarks.push(...(await this.unreadable(all)))
    if (ok.length === 0) return { status: 'not_deduced', reason: 'source_not_synced', remarks }
    const items = await this.workItems()
    if (items === 'too_many') return { status: 'not_deduced', reason: 'too_many_rows' }
    // Only the counted trackers: the work items of the others never enter the block.
    const counted = items.filter((i) => ok.some((s) => s.sourceId === i.sourceId))
    // A sprint no work item is in: its name is likely not the tracker's, never a count of zero.
    const sprints = filter.sprints
    if (
      sprints !== undefined &&
      sprints.length > 0 &&
      !counted.some((i) => matchesTrackerFilter(i, { sprints }))
    ) {
      remarks.push({ code: 'sprint_not_found', sprint: sprints.join(', ') })
      return { status: 'not_deduced', reason: 'sprint_not_found', remarks }
    }
    const decisions = this.decided(q, counted, ok)
    const decided = decisions.kept
    // Whether the decisions of the PM changed what is counted: then the counts say so.
    const shaped = decided.length !== counted.length || decided.some((d, i) => d !== counted[i])
    const matched = sortWorkItems(decided.filter((i) => matchesTrackerFilter(i, filter)))
    const sourceOf = (id: SourceId) => ok.find((s) => s.sourceId === id) as TrackerSourceView
    // A tracker of the project that could not be read: its counts are of unknown age, cited by
    // every count and total of the block, so the gates suspend them.
    const missing: DocumentSourceRef[] = all
      .filter((s) => !ok.includes(s))
      .map((s) => {
        const ref: DocumentSourceRef = {
          kind: 'work_item_counts',
          sourceId: s.sourceId,
          query: blockId,
        }
        this.note(
          ref,
          recipeText('gathering', 'note_work_item_counts', { source: s.label }, this.lang),
          null,
        )
        this.read(ref, { count: null, story_points: null })
        return ref
      })
    // The counts of each tracker, computed by the code: what a count or a total cites.
    const read: DocumentSourceRef[] = ok.map((s) => {
      const ref: DocumentSourceRef = {
        kind: 'work_item_counts',
        sourceId: s.sourceId,
        query: blockId,
      }
      const mine = matched.filter((i) => i.sourceId === s.sourceId)
      const points = mine.some((i) => i.storyPoints !== null)
        ? Math.round(mine.reduce((n, i) => n + (i.storyPoints ?? 0), 0) * 1000) / 1000
        : null
      this.note(
        ref,
        recipeText(
          'gathering',
          shaped ? 'note_work_item_counts_decided' : 'note_work_item_counts',
          { source: s.label },
          this.lang,
        ),
        iso(trackerDataAsOf(s)),
      )
      this.read(ref, { count: mine.length, story_points: points })
      return ref
    })
    const totals = [...read, ...missing]
    if (q.groupBy !== undefined) {
      // A feature the PM named in an attribution is shown as the PM wrote it, unless the tracker
      // has a work item of that id; any other feature by its title.
      const named = new Set([...decisions.attributed].map((i) => i.parent))
      const featureOf = (sourceId: string, key: string | null) =>
        key === null || (named.has(key) && this.itemOf(sourceId, key) === undefined)
          ? key
          : this.labelOf(sourceId, key)
      // A feature is found up the parents among every work item counted, not only those matched.
      const rows = groupWorkItems(matched, q.groupBy, decisions.all, {
        attributed: (i) => decisions.attributed.has(i),
        excluded: (i) => decisions.excluded.has(i),
      }).map((g): GatheredRow => {
        const ref = read.find((t) => t.kind === 'work_item_counts' && t.sourceId === g.sourceId)
        const values: Record<string, FieldValue> = {
          key: q.groupBy === 'feature' ? featureOf(g.sourceId, g.key) : g.key,
          count: g.count,
          story_points: g.storyPoints,
        }
        this.read(ref as DocumentSourceRef, values)
        return { values, refs: everyField(values, ref as DocumentSourceRef) }
      })
      if (rows.length > MAX_BLOCK_ROWS) return { status: 'not_deduced', reason: 'too_many_rows' }
      return { status: 'read', rows, totals, remarks }
    }
    return {
      status: 'read',
      rows: matched.map((i) => this.itemRow(i, sourceOf(i.sourceId))),
      totals,
      remarks,
    }
  }

  /**
   * The work items with the decisions of the PM applied: the excluded ones left out (`kept`) and,
   * in a count, the attributed ones under the parent the PM gave. `all` keeps the excluded ones
   * too, for the chain of the parents a feature is found along, with what the PM decided of each.
   * Only the PM decides them, never the model.
   */
  private decided(
    q: Extract<RecipeQuery, { kind: 'tracker' }>,
    items: WorkItem[],
    sources: readonly TrackerSourceView[],
  ): {
    kept: WorkItem[]
    all: WorkItem[]
    attributed: ReadonlySet<WorkItem>
    excluded: ReadonlySet<WorkItem>
  } {
    const d = q.decisions
    if (d === undefined)
      return { kept: items, all: items, attributed: new Set(), excluded: new Set() }
    const excluded = d.excluded === undefined ? undefined : this.params[d.excluded.parameter]
    const left =
      excluded?.type === 'work_item_selection'
        ? new Set(excluded.items.map((i) => canonicalJson([i.sourceId, i.id])))
        : new Set<string>()
    // Attributions change only what the code counts: a row of a work item stays as the tracker
    // gives it, so its fields keep citing the tracker.
    const table =
      d.attributions === undefined || q.groupBy === undefined
        ? undefined
        : this.params[d.attributions.parameter]
    // An attribution names a work item by its id and, when the table has the column, by the
    // tracker it is in: an id two trackers share, without its tracker, is attributed to neither.
    const fold = (t: string) => t.trim().toLowerCase()
    const labelOf = new Map(sources.map((s) => [s.sourceId as string, fold(s.label)]))
    const ids = new Map<string, number>()
    for (const i of items) ids.set(i.externalId, (ids.get(i.externalId) ?? 0) + 1)
    const parents = new Map<string, string>()
    const a = d.attributions
    if (table?.type === 'rows' && a !== undefined) {
      for (const r of table.rows) {
        const tracker = a.source === undefined ? '' : fold(String(r[a.source]))
        parents.set(canonicalJson([tracker, String(r[a.item])]), String(r[a.parent]))
      }
    }
    const parentOf = (i: WorkItem): string | undefined =>
      parents.get(canonicalJson([labelOf.get(i.sourceId) ?? '', i.externalId])) ??
      ((ids.get(i.externalId) ?? 0) === 1
        ? parents.get(canonicalJson(['', i.externalId]))
        : undefined)
    const attributed = new Set<WorkItem>()
    const excludedItems = new Set<WorkItem>()
    const all = items.map((i) => {
      const parent = parentOf(i)
      const out = parent === undefined ? i : { ...i, parent }
      if (parent !== undefined) attributed.add(out)
      if (left.has(canonicalJson([i.sourceId, i.externalId]))) excludedItems.add(out)
      return out
    })
    return {
      kept: all.filter((i) => !excludedItems.has(i)),
      all,
      attributed,
      excluded: excludedItems,
    }
  }

  private async selectedItems(
    selected: ReadonlyArray<{ sourceId: string; id: string }>,
  ): Promise<GatheredBlock> {
    const all = await this.trackerSources()
    if (all.length === 0) return { status: 'not_deduced', reason: 'no_source' }
    // The trackers of what the PM selected: those are read, whatever version they reach (the
    // gates judge an internal one in a client document).
    this.noteTrackers(all.filter((s) => selected.some((x) => x.sourceId === s.sourceId)))
    const ok = await this.readable()
    if (ok.length === 0) return { status: 'not_deduced', reason: 'source_not_synced' }
    const items = await this.workItems()
    if (items === 'too_many') return { status: 'not_deduced', reason: 'too_many_rows' }
    const rows: GatheredRow[] = []
    let dropped = 0
    for (const s of selected) {
      // A work item no longer in the tracker (or its perimeter) is not shown, but counted.
      const item = items.find((i) => i.sourceId === s.sourceId && i.externalId === s.id)
      const source = ok.find((o) => o.sourceId === s.sourceId)
      if (item && source) rows.push(this.itemRow(item, source))
      else dropped++
    }
    const remarks: BlockRemark[] = await this.unreadable()
    if (dropped > 0) remarks.unshift({ code: 'selection_dropped', count: dropped })
    return { status: 'read', rows, totals: [], remarks }
  }

  // System rows ----------------------------------------------------------------------------------

  private systemRef(
    view: RecipeSystemView,
    values: Readonly<Record<string, unknown>>,
    rowKey: string,
  ): DocumentSourceRef {
    const keyColumns = Object.hasOwn(DWSI_VIEW_KEYS, view.view) ? DWSI_VIEW_KEYS[view.view] : []
    const columns = [
      // Several project codes may hold the same key: the code tells their rows apart.
      ...((keyColumns ?? []).includes('projectid') ? [] : ['projectid']),
      ...(keyColumns ?? []),
    ]
    const key = columns.map((column) => ({
      column,
      value: values[column] === null || values[column] === undefined ? '' : String(values[column]),
    }))
    // Rows that share their key are ranked by the extractor (`…#2`): the rank tells them apart.
    const rank = /#(\d+)$/.exec(rowKey)
    if (rank) key.push({ column: 'occurrence', value: rank[1] as string })
    return { kind: 'system_row', sourceId: view.sourceId, view: view.view, key }
  }

  private async systemBlock(
    q: Extract<RecipeQuery, { kind: 'system_rows' }>,
  ): Promise<GatheredBlock> {
    // An equality the PM skipped never widens the rows to the whole view: «non dedotto».
    const where: Array<{ column: string; equals: string | number }> = []
    for (const w of q.where ?? []) {
      if (typeof w.equals !== 'object') {
        where.push({ column: w.column, equals: w.equals })
        continue
      }
      const p = Object.hasOwn(this.params, w.equals.parameter)
        ? this.params[w.equals.parameter]
        : undefined
      const value =
        p?.type === 'number' ? p.value : p?.type === 'text' || p?.type === 'choice' ? p.value : null
      if (value === null) return { status: 'not_deduced', reason: 'parameter_skipped' }
      where.push({ column: w.column, equals: value })
    }
    let views = this.views.get(q.view)
    if (views === undefined) {
      views = [...(await this.deps.reader.systemViews(this.tx, this.deps.projectId, q.view))].sort(
        (a, b) =>
          a.sourceId.localeCompare(b.sourceId) ||
          (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0),
      )
      this.views.set(q.view, views)
    }
    if (views.length === 0) return { status: 'not_deduced', reason: 'no_source' }
    // A period the PM skipped never widens the rows to every date: «non dedotto».
    const period = q.dates === undefined ? undefined : this.period(q.dates.period)
    if (period === null) return { status: 'not_deduced', reason: 'parameter_skipped' }
    const inPeriod = (values: Record<string, FieldValue>): boolean => {
      if (q.dates === undefined || period === undefined) return true
      const v = values[q.dates.column]
      const day = typeof v === 'object' && v !== null && 'day' in v ? v.day : null
      return day !== null && day >= period.from && day <= period.to
    }
    const rows: GatheredRow[] = []
    for (const view of views) {
      this.sourceKinds[view.sourceId] = 'netsuite_dwsi'
      this.fresh(`system:${view.sourceId}`, 'system', 'netsuite_dwsi', view.dataAsOf, {
        extractedAt: view.extractedAt.toISOString(),
        sourceSyncedAt: iso(view.sourceSyncedAt),
      })
      const sorted = [...view.rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      for (const row of sorted) {
        const values: Record<string, FieldValue> = {}
        for (const [column, raw] of Object.entries(row.values)) {
          values[column] = systemValue(view.view, column, raw)
        }
        if (!where.every((w) => sameValue(values[w.column], w.equals))) continue
        if (!inPeriod(values)) continue
        if (rows.length === MAX_BLOCK_ROWS)
          return { status: 'not_deduced', reason: 'too_many_rows' }
        const ref = this.systemRef(view, row.values, row.key)
        this.note(ref, view.evidenceTitle, iso(view.dataAsOf))
        this.read(ref, values)
        this.snapRows.set(canonicalJson([view.extractionId, row.key]), {
          sourceId: view.sourceId,
          scope: view.scope,
          view: view.view,
          extractionId: view.extractionId,
          rowKey: row.key,
          valuesHash: canonicalHash(row.values),
          values: row.values,
          dataAsOf: iso(view.dataAsOf),
          extractedAt: view.extractedAt.toISOString(),
          sourceSyncedAt: iso(view.sourceSyncedAt),
        })
        rows.push({ values, refs: everyField(values, ref) })
      }
    }
    return { status: 'read', rows, totals: [] }
  }

  // Facts ------------------------------------------------------------------------------------------

  private async factsBlock(q: Extract<RecipeQuery, { kind: 'facts' }>): Promise<GatheredBlock> {
    let facts = this.factsOf.get(q.factKind)
    if (facts === undefined) {
      facts = [...(await this.deps.reader.facts(this.tx, this.deps.projectId, q.factKind))].sort(
        (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || byId(a, b),
      )
      this.factsOf.set(q.factKind, facts)
    }
    const catalog = await this.evidence()
    const rows: GatheredRow[] = []
    for (const f of facts) {
      if (f.state === 'superseded') continue
      if (q.key !== undefined && !factKeyMatches(q.factKind, q.key, f.key)) continue
      // A fact «fonte rimossa» is out (`factSourceRemoved`, the criterion of search and answers);
      // a source its source removed no longer stands for a fact that keeps another.
      const isRemoved = (id: string) => (catalog.get(id)?.removedAt ?? null) !== null
      if (factSourceRemoved(f, isRemoved)) continue
      const sources = f.sources.flatMap((s) => {
        const e = catalog.get(s.evidenceId)
        return e && !isRemoved(e.id) ? [e] : []
      })
      // Nor does a fact with no visible source that the PM did not state: no number without one.
      if (!f.pmAsserted && sources.length === 0) continue
      const clientOnly =
        sources.length > 0 &&
        sources.every(
          (e) =>
            e.kind !== null &&
            e.audience === 'client' &&
            !isInternalOnly(e.kind, isSystemDataSource(e.sourceKind)),
        )
      if (q.audience === 'client' && !clientOnly) continue
      const ref: DocumentSourceRef = { kind: 'fact', factId: f.id }
      const values: Record<string, FieldValue> = {
        key: f.key,
        statement: f.statement,
        value: f.value,
      }
      const dataAsOf = f.unknownAge ? null : f.date
      const policy = factPolicy(
        sources.map((e) => ({ freshnessPolicy: e.policy, superseded: false })),
        f.pmAsserted,
      ).freshnessPolicy
      this.note(ref, recipeText('gathering', 'note_fact', { key: f.key }, this.lang), iso(dataAsOf))
      this.read(ref, values)
      this.fresh(`fact:${f.id}`, policy, null, dataAsOf)
      this.factAudience[f.id] = { kind: f.kind, clientOnly }
      this.factPolicies[f.id] = { policy }
      for (const e of sources) this.knowEvidence(e)
      this.snapFacts.set(f.id, {
        id: f.id,
        version: f.version,
        state: f.state,
        lockedByPm: f.lockedByPm,
      })
      this.contradictionOf(f, ref, catalog)
      if (rows.length === MAX_BLOCK_ROWS) return { status: 'not_deduced', reason: 'too_many_rows' }
      rows.push({ values, refs: everyField(values, ref) })
    }
    return { status: 'read', rows, totals: [] }
  }

  /**
   * The disagreement of a contested fact with what newer evidence says: both sides, never one
   * chosen. A fact the PM corrected has no contradiction: the correction wins.
   */
  private contradictionOf(
    f: RecipeFactView,
    ref: DocumentSourceRef,
    catalog: ReadonlyMap<string, RecipeEvidenceView>,
  ): void {
    if (f.lockedByPm || f.state !== 'contested') return
    const others = f.candidates.flatMap((c) => {
      const s = c.sources.find((x) => {
        const e = catalog.get(x.evidenceId)
        return e !== undefined && e.removedAt === null
      })
      if (s === undefined) return []
      const e = catalog.get(s.evidenceId) as RecipeEvidenceView
      const side: DocumentSourceRef = {
        kind: 'evidence',
        evidenceId: s.evidenceId,
        locator: s.locator,
      }
      this.noteEvidence(e, side)
      return [{ value: c.value ?? c.statement, source: side }]
    })
    if (others.length === 0) {
      this.contested.add(f.id)
      return
    }
    this.contradictions.set(f.id, {
      key: `fact:${f.id}`,
      subject: recipeText('gathering', 'contradiction_subject', { kind: f.kind }, this.lang),
      sides: [{ value: f.value ?? f.statement, source: ref }, ...others],
    })
  }

  // Blocks ------------------------------------------------------------------------------------------

  /**
   * The rows of a block. `forClient`: the block reaches the client version, by its section or by
   * a value of that version that counts it (`blocksReadForClient`); any other block of the
   * internal version reads every tracker, also in a run for the client.
   */
  async block(b: RowsBlock, forClient = true): Promise<GatheredBlock> {
    const q = b.query
    switch (q.kind) {
      case 'tracker':
        return this.trackerBlock(b.id, q, forClient)
      case 'system_rows':
        return this.systemBlock(q)
      case 'facts':
        return this.factsBlock(q)
      case 'evidence':
        return this.evidenceBlock(q)
      case 'parameter': {
        const v = Object.hasOwn(this.params, q.parameter) ? this.params[q.parameter] : undefined
        if (v === undefined) return { status: 'not_deduced', reason: 'parameter_skipped' }
        if (v.type === 'work_item_selection') return this.selectedItems(v.items)
        if (v.type === 'evidence_selection') {
          const catalog = await this.evidence()
          const chosen = v.evidenceIds.flatMap((id) => {
            const e = catalog.get(id)
            return e && e.removedAt === null ? [e] : []
          })
          const dropped = v.evidenceIds.length - chosen.length
          return {
            status: 'read',
            rows: await this.evidenceRows(chosen),
            totals: [],
            remarks: dropped > 0 ? [{ code: 'selection_dropped', count: dropped }] : [],
          }
        }
        if (v.type === 'rows') {
          const p = this.recipe.parameters.find((x) => x.id === q.parameter)
          if (p?.type !== 'rows') return { status: 'not_deduced', reason: 'parameter_skipped' }
          const rows = typedRowsRead(p.id, p.columns, v.rows, this.copiedFrom(p.evidence))
          return { status: 'read', rows, totals: [] }
        }
        const ref: DocumentSourceRef = { kind: 'parameter', parameterId: q.parameter }
        const values = { value: this.parameterField(q.parameter, v) }
        return { status: 'read', rows: [{ values, refs: { value: ref } }], totals: [] }
      }
    }
  }

  async result(blocks: Record<string, GatheredBlock>, clientCategories: readonly DataCategory[]) {
    const catalog = await this.evidence()
    // Whose data each tracker holds, as the PM said when the run gathered: the gates judge a work
    // item cited in a client document by it.
    const trackers = Object.fromEntries(
      (await this.trackerSources()).map((s) => [s.sourceId as string, s.audience]),
    )
    // How each block was read, for the PM: shown with the red-team, never as a datum.
    const remarks: Record<string, readonly BlockRemark[]> = {}
    for (const [id, block] of Object.entries(blocks)) {
      if (block.remarks !== undefined && block.remarks.length > 0) remarks[id] = block.remarks
    }
    const removed = [...catalog.values()].filter((e) => e.removedAt !== null).sort(byId)
    const now = this.deps.now.toISOString()
    const gathered: GatheredData = {
      recipe: { slug: this.recipe.slug, version: this.recipe.version },
      lang: this.lang,
      referenceTime: now,
      parameters: this.params,
      parameterTexts: parameterTitleTexts(this.recipe, this.params, this.lang),
      periods: periodsOf(this.params),
      blocks,
      notes: [...this.notes.values()],
      readLog: this.readLog,
      freshness: [...this.freshness.values()].sort((a, b) => (a.source < b.source ? -1 : 1)),
      contradictions: [...this.contradictions.values()],
      contestedFacts: [...this.contested].sort(),
      removedEvidence: removed.map((e) => e.id),
      context: {
        evidence: this.evidenceAudience,
        facts: this.factAudience,
        freshness: {
          now,
          thresholds: tightenFreshness(this.thresholds),
          sourceKinds: this.sourceKinds,
          evidence: this.evidencePolicy,
          facts: this.factPolicies,
        },
        trackers,
        remarks,
      },
    }
    const sorted = <T>(m: Map<string, T>) =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
    const snapshot: InputSnapshot = {
      schema: INPUT_SNAPSHOT_SCHEMA,
      referenceTime: now,
      recipe: { slug: this.recipe.slug, version: this.recipe.version, hash: this.deps.recipeHash },
      modelAlias: this.deps.modelAlias,
      parameters: this.params,
      settingsHash: this.deps.settingsHash,
      ...(this.deps.render === undefined ? {} : { render: this.deps.render }),
      policies: {
        freshness: tightenFreshness(this.thresholds),
        clientCategories: [...clientCategories].sort(),
      },
      evidence: sorted(this.snapEvidence),
      tracker: sorted(this.snapTracker),
      systemRows:
        this.snapRows.size <= MAX_SNAPSHOT_ROW_VALUES
          ? sorted(this.snapRows)
          : sorted(this.snapRows).map(({ values: _values, ...identity }) => identity),
      facts: sorted(this.snapFacts),
      removals: removed.map((e) => ({
        evidenceId: e.id,
        removedAt: (e.removedAt as Date).toISOString(),
      })),
    }
    return { gathered, snapshot }
  }
}

/**
 * Gathers what a run of `recipe` reads, with the values the PM gave its parameters: every data
 * block of the recipe, in one transaction of the user the run is for, as of `deps.now`. The
 * blocks of a section that reads a mandatory parameter the PM skipped are not read («non
 * dedotto»). Returns the gathered data, the input of the skeleton, and the snapshot of the
 * inputs to save with the run. The model is never called.
 *
 * Throws `recipe_parameter_invalid` for a value that does not fit its parameter and
 * `project_not_accessible` for a project the user cannot read.
 */
export async function gatherRecipeData<Tx>(
  recipe: Recipe,
  values: ParameterValues,
  deps: GatherDeps<Tx>,
): Promise<GatherResult> {
  const params = checkParameterValues(recipe, values)
  const lang = recipe.lang as Lang
  const skipped = notDeducedSections(recipe, params)
  return deps.withTx(async (tx) => {
    const project = await deps.reader.project(tx, deps.projectId)
    if (project === null) throw new DomainError('project_not_accessible')
    const g = new Gathering(recipe, params, lang, project.thresholds, deps, tx)
    g.noteParameters()
    // A list of the internal version a value for the client counts is read as the client's too.
    const forClient = blocksReadForClient(recipe)
    const blocks: Record<string, GatheredBlock> = {}
    for (const section of recipe.sections) {
      for (const b of section.blocks) {
        if (b.kind !== 'data_table' && b.kind !== 'data_list') continue
        blocks[b.id] = skipped.has(section.id)
          ? { status: 'not_deduced', reason: 'parameter_skipped' }
          : await g.block(b, forClient.has(b.id))
      }
    }
    return g.result(blocks, deps.clientCategories ?? DEFAULT_CLIENT_CATEGORIES)
  })
}
