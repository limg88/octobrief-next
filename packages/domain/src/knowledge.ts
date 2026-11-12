import { canonicalText } from './canonical.ts'
import { DomainError } from './errors.ts'
import { isLocator, type Locator, locatorKey } from './extraction.ts'
import type { EvidenceId, FactId, ProjectId } from './ids.ts'
import { newId, parseId } from './ids.ts'
import { type Lang, vocabulary } from './language/index.ts'
import { factSourceRemoved, type IsRemoved } from './source-removals.ts'
import { looksLikeInstruction } from './suspicious.ts'

export const FACT_KINDS = [
  'person',
  'decision',
  'risk',
  'action',
  'status',
  'milestone',
  'economics',
  'note',
] as const
export type FactKind = (typeof FACT_KINDS)[number]

/** What each kind of fact is, in the language of the compile: one short definition per kind. */
export function factKindDefinitions(lang: Lang): Readonly<Record<FactKind, string>> {
  return vocabulary(lang).FACT_KIND_DEFINITIONS
}

export const FACT_STATES = ['active', 'contested', 'superseded'] as const
export type FactState = (typeof FACT_STATES)[number]

export const FACT_ORIGINS = ['compile', 'pm'] as const
export type FactOrigin = (typeof FACT_ORIGINS)[number]

/** Longest excerpt kept with a source: the exact text of the fragment, never a summary. */
export const MAX_EXCERPT_LENGTH = 300

/** Most sources one proposal may carry: more is a sign of a runaway answer, and is refused. */
export const MAX_SOURCES_PER_PROPOSAL = 10

/** Where a fact comes from: a piece of evidence, the place in it and the exact fragment. */
export interface SourceRef {
  evidenceId: EvidenceId
  locator: Locator
  excerpt: string
}

export interface Fact {
  id: FactId
  projectId: ProjectId
  kind: FactKind
  /** Normalized subject, e.g. `risk:fornitore-ritardo`. */
  key: string
  statement: string
  value: string | null
  sources: SourceRef[]
  origin: FactOrigin
  state: FactState
  lockedByPm: boolean
  /** Stated by the PM without evidence («indicato da te»): counts as a source of its own. */
  pmAsserted: boolean
  createdAt: Date
}

export interface ProposedFact {
  kind: FactKind
  key: string
  statement: string
  value: string | null
  sources: SourceRef[]
}

export type ApplyOutcome =
  | { kind: 'insert'; fact: Fact }
  | { kind: 'add_sources'; factId: FactId; sources: SourceRef[] }
  | { kind: 'contradiction'; factId: FactId; proposed: ProposedFact }
  /**
   * The fact is «fonte rimossa» (every source of it removed at its source), or superseded (the
   * document it came from was read again without it): a new value with a standing source takes
   * its place, as a new version, since nothing stands against it.
   */
  | { kind: 'replace'; factId: FactId; proposed: ProposedFact }
  | { kind: 'locked_conflict'; factId: FactId; proposed: ProposedFact }
  /** Two statements without a value that may say different things: the PM is asked. */
  | { kind: 'possible_contradiction'; factId: FactId; proposed: ProposedFact }
  | {
      kind: 'rejected'
      reason:
        | 'instruction_like'
        | 'no_sources'
        | 'invalid_source'
        | 'same_document_contradiction'
        /** Evidence agreeing with a fact the PM stated: the PM's word stays its only source. */
        | 'pm_asserted'
    }

export interface ApplyContext {
  lang: Lang
  projectId: ProjectId
  now: Date
  /** Evidence removed at its source; absent, nothing is removed. */
  isRemoved?: IsRemoved
}

/** Lowercase, NFC, trimmed, runs of whitespace collapsed to one space. */
export function normalizeKey(key: string): string {
  return key.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function normalizeValue(value: string, lang: Lang): string {
  const text = normalizeKey(value)
  if (vocabulary(lang).PURE_NUMBER.test(text)) return text.replaceAll('.', '')
  return text
}

/** The stored key: normalized and always starting with the kind, so kinds never collide. */
export function keyOf(kind: FactKind, key: string): string {
  const normalized = normalizeKey(key)
  return normalized.startsWith(`${kind}:`) ? normalized : `${kind}:${normalized}`
}

/**
 * A statement as compared with another: canonical, lowercase, spacing collapsed and without the
 * final punctuation, so the same sentence written twice compares equal.
 */
export function normalizeStatement(statement: string): string {
  return normalizeKey(canonicalText(statement)).replace(/[\s.;:!]+$/u, '')
}

/** Same value ignoring case and spacing; pure numbers also ignore thousands separators. */
export function valuesEqual(a: string | null, b: string | null, lang: Lang): boolean {
  if (a === null || b === null) return a === b
  return normalizeValue(a, lang) === normalizeValue(b, lang)
}

/** Whether a stored excerpt respects the limit (data read back from storage). */
export function isValidExcerpt(excerpt: string): boolean {
  return excerpt.trim().length > 0 && excerpt.length <= MAX_EXCERPT_LENGTH
}

export const sourceKey = (s: SourceRef): string => `${s.evidenceId}|${locatorKey(s.locator)}`

/** Sources without duplicates (same evidence and place), first occurrence kept. */
export function mergeSources(base: readonly SourceRef[], extra: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>()
  const merged: SourceRef[] = []
  for (const s of [...base, ...extra]) {
    const k = sourceKey(s)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(s)
  }
  return merged
}

/**
 * Decides what a proposed fact does to the existing knowledge (pure and deterministic; the
 * caller performs the effects). The PM's locked facts are never changed; contradictions between
 * different pieces of evidence are kept side by side, never resolved.
 */
export function applyProposal(
  existing: readonly Fact[],
  proposal: ProposedFact,
  ctx: ApplyContext,
): ApplyOutcome {
  if (proposal.sources.length === 0) return { kind: 'rejected', reason: 'no_sources' }
  if (
    proposal.sources.length > MAX_SOURCES_PER_PROPOSAL ||
    !proposal.sources.every((s) => isValidExcerpt(s.excerpt))
  ) {
    return { kind: 'rejected', reason: 'invalid_source' }
  }
  // Excerpts are quotations of the evidence and stay as they are; everything the product says
  // in its own voice (statement, value, key) must not read as an instruction.
  const spoken = [proposal.statement, proposal.value ?? '', proposal.key]
  if (spoken.some((text) => looksLikeInstruction(text, ctx.lang))) {
    return { kind: 'rejected', reason: 'instruction_like' }
  }
  const key = keyOf(proposal.kind, proposal.key)
  const proposed: ProposedFact = { ...proposal, key, sources: mergeSources([], proposal.sources) }
  const current = existing.find((f) => normalizeKey(f.key) === key)

  // A fact superseded by a new reading of its document holds nothing: the proposal takes its
  // place, active again (a fact the PM locked is never superseded by a reading).
  if (current && current.state === 'superseded' && !current.lockedByPm) {
    return { kind: 'replace', factId: current.id, proposed }
  }

  if (!current) {
    return {
      kind: 'insert',
      fact: Object.freeze({
        id: newId<FactId>(),
        projectId: ctx.projectId,
        kind: proposed.kind,
        key,
        statement: proposed.statement,
        value: proposed.value,
        sources: Object.freeze(proposed.sources) as SourceRef[],
        origin: 'compile',
        state: 'active',
        lockedByPm: false,
        pmAsserted: false,
        createdAt: new Date(ctx.now.getTime()),
      }),
    }
  }

  // Facts without a value (decisions, risks, notes) are told apart by what they say.
  const withoutValue = current.value === null && proposal.value === null
  const agrees = withoutValue
    ? normalizeStatement(current.statement) === normalizeStatement(proposal.statement)
    : valuesEqual(current.value, proposal.value, ctx.lang)

  if (agrees) {
    // The PM's own word is the source of a fact it stated: agreeing evidence adds nothing to it.
    if (current.pmAsserted) return { kind: 'rejected', reason: 'pm_asserted' }
    const known = new Set(current.sources.map(sourceKey))
    return {
      kind: 'add_sources',
      factId: current.id,
      sources: proposed.sources.filter((s) => !known.has(sourceKey(s))),
    }
  }

  if (current.lockedByPm) return { kind: 'locked_conflict', factId: current.id, proposed }
  // A fact whose sources were all removed at the source has nothing left to contradict.
  if (ctx.isRemoved && factSourceRemoved(current, ctx.isRemoved)) {
    return { kind: 'replace', factId: current.id, proposed }
  }

  const theirs = new Set<EvidenceId>(proposed.sources.map((s) => s.evidenceId))
  if (current.sources.length > 0 && current.sources.every((s) => theirs.has(s.evidenceId))) {
    return { kind: 'rejected', reason: 'same_document_contradiction' }
  }
  if (withoutValue) return { kind: 'possible_contradiction', factId: current.id, proposed }
  return { kind: 'contradiction', factId: current.id, proposed }
}

/** What reading a document again does to one fact it was a source of. */
export interface RereadChange {
  factId: FactId
  /** The sources of the fact without those of the document read again. */
  sources: SourceRef[]
  /** `superseded` when the document was its only source; otherwise its state as it was. */
  state: FactState
}

/**
 * The facts a new reading of a piece of evidence replaces, before its new facts are applied: each
 * fact of the compile that cites it loses the sources of it, and a fact left without any source
 * is superseded (kept in its history, no longer active; a new fact of its key takes its place).
 * A fact the PM corrected, locked or stated is never touched: the PM's word wins and stays.
 */
export function factsToReread(facts: readonly Fact[], evidenceId: EvidenceId): RereadChange[] {
  const changes: RereadChange[] = []
  for (const fact of facts) {
    if (fact.origin !== 'compile' || fact.lockedByPm || fact.pmAsserted) continue
    if (fact.state === 'superseded') continue
    if (!fact.sources.some((s) => s.evidenceId === evidenceId)) continue
    const sources = fact.sources.filter((s) => s.evidenceId !== evidenceId)
    changes.push({
      factId: fact.id,
      sources,
      state: sources.length === 0 ? 'superseded' : fact.state,
    })
  }
  return changes
}

/**
 * Identity of a candidate for the inbox: the normalized value (the normalized statement, for a
 * candidate without a value) and the evidence it comes from, not the place in the document. The
 * same candidate asked twice has one print.
 */
export function candidateFingerprint(proposed: ProposedFact, lang: Lang): string {
  const value =
    proposed.value === null
      ? `\u001fnull:${normalizeStatement(proposed.statement)}`
      : normalizeValue(proposed.value, lang)
  const evidence = [...new Set(proposed.sources.map((x) => x.evidenceId))].sort()
  return `${value}|${evidence.join(',')}`
}

/** A fact as read back from storage, before its fields are checked. */
export interface StoredFact {
  id: string
  projectId: string
  kind: string
  key: string
  statement: string
  value: string | null
  state: string
  origin: string
  lockedByPm: boolean
  pmAsserted: boolean
  createdAt: Date
  sources: readonly { evidenceId: string; locator: unknown; excerpt: string }[]
}

function invalid(): never {
  throw new DomainError('stored_value_invalid')
}

/** Rebuilds a stored fact, refusing (`stored_value_invalid`) one the domain could not have made. */
export function rehydrateFact(row: StoredFact): Fact {
  if (!(FACT_KINDS as readonly string[]).includes(row.kind)) invalid()
  if (!(FACT_STATES as readonly string[]).includes(row.state)) invalid()
  if (!(FACT_ORIGINS as readonly string[]).includes(row.origin)) invalid()
  if ((row.lockedByPm || row.pmAsserted) && row.origin !== 'pm') invalid()
  if (normalizeKey(row.key) !== row.key) invalid()
  const sources = row.sources.map((s): SourceRef => {
    if (!isLocator(s.locator) || !isValidExcerpt(s.excerpt)) invalid()
    return Object.freeze({
      evidenceId: parseId<EvidenceId>(s.evidenceId),
      locator: s.locator,
      excerpt: s.excerpt,
    })
  })
  return Object.freeze({
    id: parseId<FactId>(row.id),
    projectId: parseId<ProjectId>(row.projectId),
    kind: row.kind as FactKind,
    key: row.key,
    statement: row.statement,
    value: row.value,
    sources: Object.freeze(sources) as SourceRef[],
    origin: row.origin as FactOrigin,
    state: row.state as FactState,
    lockedByPm: row.lockedByPm,
    pmAsserted: row.pmAsserted,
    createdAt: new Date(row.createdAt.getTime()),
  })
}
