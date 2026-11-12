import { canonicalText, hasMixedScript } from './canonical.ts'
import { isLocator, type Locator } from './extraction.ts'
import type { EvidenceId, FactId, SourceId } from './ids.ts'
import { LANGS, type Lang } from './language/index.ts'
import {
  canonicalTrackerLocator,
  isTrackerLocator,
  type TrackerLocator,
  WORK_ITEM_FIELDS,
} from './tracker.ts'

// The contract of an answer of the model. It carries what the model says and which sources it
// cites, never a title, a date or a freshness: those come from the registry, computed by code.

export const NATURES = ['fact', 'inference', 'suggestion'] as const
export type Nature = (typeof NATURES)[number]

/**
 * A citation: a place of a piece of evidence, a fact of the knowledge, or a place of the tracker
 * of a tracker source (a work item, one of its fields, the counts). Exactly one form.
 */
export type AnswerSourceRef =
  | { evidenceId: EvidenceId; locator: Locator }
  | { factId: FactId }
  | { sourceId: SourceId; locator: TrackerLocator }

export interface AnswerSegment {
  text: string
  nature: Nature
  sources: AnswerSourceRef[]
}

export interface AnswerContradiction {
  subject: string
  /** 2..5 sides, each with the value and the source that states it. */
  sides: Array<{ value: string; source: AnswerSourceRef }>
  reason: string
}

/** Something the sources do not say, with a question for the PM and a proposal. */
export interface AnswerAbsence {
  question: string
  proposal: string
}

export interface ModelAnswer {
  lang: Lang
  segments: AnswerSegment[]
  contradictions: AnswerContradiction[]
  absences: AnswerAbsence[]
  /**
   * Set by `parseModelAnswer`, never by the model: the paths of the texts holding a word that
   * mixes Latin with Cyrillic or Greek letters. `verifyAnswer` checks the texts again on its own.
   */
  mixedScript?: string[]
}

export const ANSWER_LIMITS = Object.freeze({
  segmentsMax: 50,
  /** Characters (code points), as JSON Schema counts them. */
  textMax: 2000,
  sourcesPerSegmentMax: 10,
  contradictionsMax: 10,
  sidesMin: 2,
  sidesMax: 5,
  absencesMax: 10,
  /** Subjects, values, reasons, questions and proposals. */
  shortTextMax: 500,
  idMax: 100,
})

export type JsonSchema = Readonly<Record<string, unknown>>

// The schema sent to the model is portable (see `portableSchema`): only the shape. Blank
// texts, lengths, counts, positive positions and the A1 form of a cell are enforced by
// `parseModelAnswer`, the strict reader of every answer.
const text = { type: 'string' } as const
const id = { type: 'string' } as const
const positive = { type: 'integer' } as const

const closed = <P extends Record<string, unknown>>(properties: P) =>
  ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }) as const

const locatorSchema = {
  anyOf: [
    closed({ kind: { enum: ['page'] }, page: positive }),
    closed({ kind: { enum: ['paragraph'] }, index: positive }),
    closed({ kind: { enum: ['slide'] }, slide: positive }),
    closed({
      kind: { enum: ['cell'] },
      sheet: { type: 'string' },
      ref: { type: 'string' },
    }),
    closed({ kind: { enum: ['line'] }, from: positive, to: positive }),
  ],
} as const

const trackerLocatorSchema = {
  anyOf: [
    closed({ kind: { enum: ['work_item'] }, id }),
    closed({ kind: { enum: ['work_item'] }, id, field: { enum: [...WORK_ITEM_FIELDS] } }),
    closed({ kind: { enum: ['work_item_counts'] }, query: id }),
  ],
} as const

const sourceSchema = {
  anyOf: [
    closed({ evidenceId: id, locator: locatorSchema }),
    closed({ factId: id }),
    closed({ sourceId: id, locator: trackerLocatorSchema }),
  ],
} as const

/**
 * The shape of the contract as a portable JSON Schema, for the `responseSchema` of the model
 * call. It is not the contract: `parseModelAnswer` is, and it reads every answer.
 */
export const modelAnswerSchema = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: [...LANGS] },
    segments: {
      type: 'array',
      items: closed({
        text: text,
        nature: { type: 'string', enum: [...NATURES] },
        sources: {
          type: 'array',
          items: sourceSchema,
        },
      }),
    },
    contradictions: {
      type: 'array',
      items: closed({
        subject: text,
        sides: {
          type: 'array',
          items: closed({ value: text, source: sourceSchema }),
        },
        reason: text,
      }),
    },
    absences: {
      type: 'array',
      items: closed({
        question: text,
        proposal: text,
      }),
    },
  },
  required: ['lang', 'segments', 'contradictions', 'absences'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type AnswerParseProblem = 'invalid' | 'too_long' | 'too_many' | 'too_few'

/** Where an answer breaks the contract: a path of schema keys and indices, never model text. */
export interface AnswerParseError {
  path: string
  problem: AnswerParseProblem
}

class ContractBreak {
  readonly path: string
  readonly problem: AnswerParseProblem

  constructor(path: string, problem: AnswerParseProblem) {
    this.path = path
    this.problem = problem
  }
}

const join = (path: string, key: string | number) => (path === '' ? String(key) : `${path}.${key}`)

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractBreak(path, 'invalid')
  }
  return value as Record<string, unknown>
}

function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) throw new ContractBreak(path, 'invalid')
  if (value.length > max) throw new ContractBreak(path, 'too_many')
  if (value.length < min) throw new ContractBreak(path, 'too_few')
  return value
}

function str(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractBreak(path, 'invalid')
  if ([...value].length > max) throw new ContractBreak(path, 'too_long')
  return value
}

/**
 * A text of the model in its canonical form (see `canonicalText`): blank and length are judged
 * on what will be checked and shown, so a text of invisible characters only is refused.
 */
function modelText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new ContractBreak(path, 'invalid')
  const text = canonicalText(value)
  if (text === '') throw new ContractBreak(path, 'invalid')
  if ([...text].length > max) throw new ContractBreak(path, 'too_long')
  return text
}

/** A copy of the locator with only the fields of its kind. */
function copyLocator(locator: Locator): Locator {
  switch (locator.kind) {
    case 'page':
      return { kind: 'page', page: locator.page }
    case 'paragraph':
      return { kind: 'paragraph', index: locator.index }
    case 'slide':
      return { kind: 'slide', slide: locator.slide }
    case 'cell':
      return { kind: 'cell', sheet: locator.sheet, ref: locator.ref }
    case 'line':
      return { kind: 'line', from: locator.from, to: locator.to }
  }
}

function source(value: unknown, path: string): AnswerSourceRef {
  const v = record(value, path)
  const has = (key: string) => v[key] !== undefined
  if (has('factId') && !has('evidenceId') && !has('locator') && !has('sourceId')) {
    return { factId: str(v.factId, join(path, 'factId'), ANSWER_LIMITS.idMax) as FactId }
  }
  if (has('sourceId') && has('locator') && !has('factId') && !has('evidenceId')) {
    const sourceId = str(v.sourceId, join(path, 'sourceId'), ANSWER_LIMITS.idMax)
    if (!isTrackerLocator(v.locator)) throw new ContractBreak(join(path, 'locator'), 'invalid')
    return { sourceId: sourceId as SourceId, locator: canonicalTrackerLocator(v.locator) }
  }
  if (has('evidenceId') && has('locator') && !has('factId') && !has('sourceId')) {
    const evidenceId = str(v.evidenceId, join(path, 'evidenceId'), ANSWER_LIMITS.idMax)
    if (!isLocator(v.locator)) throw new ContractBreak(join(path, 'locator'), 'invalid')
    return { evidenceId: evidenceId as EvidenceId, locator: copyLocator(v.locator) }
  }
  throw new ContractBreak(path, 'invalid')
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractBreak(path, 'invalid')
  }
  return value as T
}

function segment(value: unknown, path: string): AnswerSegment {
  const v = record(value, path)
  const sourcesPath = join(path, 'sources')
  return {
    text: modelText(v.text, join(path, 'text'), ANSWER_LIMITS.textMax),
    nature: oneOf(v.nature, NATURES, join(path, 'nature')),
    sources: list(v.sources, sourcesPath, ANSWER_LIMITS.sourcesPerSegmentMax).map((s, i) =>
      source(s, join(sourcesPath, i)),
    ),
  }
}

function contradiction(value: unknown, path: string): AnswerContradiction {
  const v = record(value, path)
  const sidesPath = join(path, 'sides')
  const short = ANSWER_LIMITS.shortTextMax
  return {
    subject: modelText(v.subject, join(path, 'subject'), short),
    sides: list(v.sides, sidesPath, ANSWER_LIMITS.sidesMax, ANSWER_LIMITS.sidesMin).map((s, i) => {
      const sidePath = join(sidesPath, i)
      const side = record(s, sidePath)
      return {
        value: modelText(side.value, join(sidePath, 'value'), short),
        source: source(side.source, join(sidePath, 'source')),
      }
    }),
    reason: modelText(v.reason, join(path, 'reason'), short),
  }
}

function absence(value: unknown, path: string): AnswerAbsence {
  const v = record(value, path)
  return {
    question: modelText(v.question, join(path, 'question'), ANSWER_LIMITS.shortTextMax),
    proposal: modelText(v.proposal, join(path, 'proposal'), ANSWER_LIMITS.shortTextMax),
  }
}

/** The paths of the texts of an answer holding a word of mixed scripts. */
function mixedScriptPaths(answer: ModelAnswer): string[] {
  const texts: Array<[string, string]> = []
  answer.segments.forEach((s, i) => {
    texts.push([join(join('segments', i), 'text'), s.text])
  })
  answer.contradictions.forEach((c, i) => {
    const path = join('contradictions', i)
    texts.push([join(path, 'subject'), c.subject])
    c.sides.forEach((side, j) => {
      texts.push([join(join(join(path, 'sides'), j), 'value'), side.value])
    })
    texts.push([join(path, 'reason'), c.reason])
  })
  answer.absences.forEach((a, i) => {
    const path = join('absences', i)
    texts.push([join(path, 'question'), a.question], [join(path, 'proposal'), a.proposal])
  })
  return texts.filter(([, text]) => hasMixedScript(text)).map(([path]) => path)
}

/**
 * Reads an answer of the model against the contract, every text in its canonical form. Fields
 * outside the contract (a title, a date, a freshness the model made up) are dropped, never read;
 * anything else that breaks the contract is refused with the path where it breaks. Texts holding
 * a word of mixed scripts are listed in `mixedScript`.
 */
export function parseModelAnswer(value: unknown): ModelAnswer | { error: AnswerParseError } {
  try {
    const v = record(value, '')
    const items = (key: string, max: number) => list(v[key], key, max)
    const answer: ModelAnswer = {
      lang: oneOf(v.lang, LANGS, 'lang'),
      segments: items('segments', ANSWER_LIMITS.segmentsMax).map((s, i) =>
        segment(s, join('segments', i)),
      ),
      contradictions: items('contradictions', ANSWER_LIMITS.contradictionsMax).map((c, i) =>
        contradiction(c, join('contradictions', i)),
      ),
      absences: items('absences', ANSWER_LIMITS.absencesMax).map((a, i) =>
        absence(a, join('absences', i)),
      ),
    }
    const mixed = mixedScriptPaths(answer)
    return mixed.length > 0 ? { ...answer, mixedScript: mixed } : answer
  } catch (e) {
    if (e instanceof ContractBreak) return { error: { path: e.path, problem: e.problem } }
    throw e
  }
}
