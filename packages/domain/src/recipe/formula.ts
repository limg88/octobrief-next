// The formulas a template may hold: an allowlist, not a denylist (a denylist of formulas is a race,
// as it was for field codes). One linear tokenizer accepts a formula only when every token is
// allowed: literals, operators, A1 references, sheets, defined names and tables of the same
// workbook, and calls of pure functions from `PURE_FUNCTIONS`. Anything else refuses the formula:
// `template_external_link` when the token names another workbook, a path or a site, and
// `template_active_content` otherwise. The renderer reads the same rules (`rules.py`) and the same
// list of functions (`schemas/formula-functions.json`, written from `PURE_FUNCTIONS`).

/** The refusals a formula can give (a subset of the refusals of a template). */
export type FormulaRefusal = 'template_active_content' | 'template_external_link'

/**
 * Functions that only compute from their arguments: no reference built from text, no link, no
 * call out, no information about the file or the machine. Stored with `_xlfn.` when recent.
 */
export const PURE_FUNCTIONS: readonly string[] = Object.freeze([
  'ABS',
  'AND',
  'AVERAGE',
  'AVERAGEA',
  'AVERAGEIF',
  'AVERAGEIFS',
  'CEILING',
  'CHOOSE',
  'COLUMN',
  'COLUMNS',
  'CONCAT',
  'CONCATENATE',
  'COUNT',
  'COUNTA',
  'COUNTBLANK',
  'COUNTIF',
  'COUNTIFS',
  'DATE',
  'DAY',
  'DAYS',
  'EDATE',
  'EOMONTH',
  'EXACT',
  'FIND',
  'FLOOR',
  'HLOOKUP',
  'IF',
  'IFERROR',
  'IFNA',
  'IFS',
  'INDEX',
  'INT',
  'ISBLANK',
  'ISERR',
  'ISERROR',
  'ISNA',
  'ISNUMBER',
  'ISTEXT',
  'LEFT',
  'LEN',
  'LOOKUP',
  'LOWER',
  'MATCH',
  'MAX',
  'MAXIFS',
  'MEDIAN',
  'MID',
  'MIN',
  'MINIFS',
  'MOD',
  'MONTH',
  'N',
  'NETWORKDAYS',
  'NOT',
  'NOW',
  'OR',
  'PRODUCT',
  'PROPER',
  'REPT',
  'RIGHT',
  'ROUND',
  'ROUNDDOWN',
  'ROUNDUP',
  'ROW',
  'ROWS',
  'SEARCH',
  'SUBSTITUTE',
  'SUBTOTAL',
  'SUM',
  'SUMIF',
  'SUMIFS',
  'SUMPRODUCT',
  'SWITCH',
  'TEXT',
  'TODAY',
  'TRIM',
  'UPPER',
  'VALUE',
  'VLOOKUP',
  'WEEKDAY',
  'WORKDAY',
  'XLOOKUP',
  'XOR',
  'YEAR',
])

/** Functions refused as links: they read a site, build a link or a reference from text. */
export const LINKING_FUNCTIONS: readonly string[] = Object.freeze([
  'FILTERXML',
  'HYPERLINK',
  'IMAGE',
  'INDIRECT',
  'WEBSERVICE',
])

/** The prefixes Excel writes before recent functions; `_xludf.` (user code) is not one. */
const FUNCTION_PREFIXES = ['_XLFN._XLWS.', '_XLFN.', '_XLWS.']

/** The error constants of a workbook. */
const ERRORS = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#GETTING_DATA',
  '#SPILL!',
  '#CALC!',
  '#FIELD!',
  '#BLOCKED!',
  '#CONNECT!',
  '#BUSY!',
  '#UNKNOWN!',
]

/**
 * What a workbook defines, with its ASCII letters in lower case (`foldAscii`): its sheets, its
 * defined names and its tables.
 */
export interface WorkbookNames {
  sheets: ReadonlySet<string>
  names: ReadonlySet<string>
  tables: ReadonlySet<string>
}

export const NO_WORKBOOK: WorkbookNames = {
  sheets: new Set(),
  names: new Set(),
  tables: new Set(),
}

const PURE = new Set(PURE_FUNCTIONS)
const LINKING = new Set(LINKING_FUNCTIONS)
/** Characters that end a word: white space, operators, separators, quotes, brackets. */
const DELIMITERS = new Set(' \t\n\r+-*/^&=<>%,;:(){}"\'[]!#@|')
const OPERATORS = new Set('+-*/^&=<>%,;:(){}@')
const CELL = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/
const COLUMN = /^\$?[A-Za-z]{1,3}$/
const ROW = /^\$?[0-9]+$/
const NUMBER_START = /[0-9]/
/** A quoted sheet reference that holds a path or a workbook (a `:` only splits a 3D one). */
const QUOTED_PATH = /[/\\[\]]/
/** A letter or a number of any script, by Unicode category: the renderer tests the same. */
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u
const NUMBER = /^\p{N}$/u

/**
 * A name with its ASCII letters in lower case and every other character as it is. Office folds
 * the case of names, but a character that folds to an ASCII letter only in Unicode (the Kelvin
 * sign, a long s, a ligature) is not that letter here: no gate accepts a name Office reads apart.
 */
export function foldAscii(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** A name with its ASCII letters in upper case: how functions and errors are compared. */
function upperAscii(value: string): string {
  return value.replace(/[a-z]/g, (c) => c.toUpperCase())
}

/** The characters a sheet name may not hold, as Excel refuses them. */
const SHEET_FORBIDDEN = new Set('\\/?*[]:')
/** The longest sheet name Excel accepts, in characters. */
export const MAX_SHEET_NAME = 31
/** The longest defined name or table name Excel accepts, in characters. */
export const MAX_DEFINED_NAME = 255

/**
 * Whether a sheet name is one Excel accepts: 1 to 31 characters, none of `\ / ? * [ ] :`, not
 * starting or ending with a quote. Characters are counted by code point, as the renderer does.
 */
export function isSheetName(name: string): boolean {
  const chars = [...name]
  if (chars.length < 1 || chars.length > MAX_SHEET_NAME) return false
  if (name.startsWith("'") || name.endsWith("'")) return false
  return chars.every((c) => !SHEET_FORBIDDEN.has(c))
}

/**
 * Whether a defined name or a table name is one Excel accepts, with no path character in it: a
 * letter or `_` first, then letters, numbers, `_` and `.`, at most 255 characters.
 */
export function isDefinedName(name: string): boolean {
  const chars = [...name]
  if (chars.length < 1 || chars.length > MAX_DEFINED_NAME) return false
  return chars.every((c, i) => {
    if (c === '_') return true
    if (c === '.') return i > 0
    return LETTER_OR_NUMBER.test(c) && (i > 0 || !NUMBER.test(c))
  })
}

const isWordChar = (c: string): boolean => {
  const code = c.codePointAt(0) ?? 0
  return code > 0x20 && code !== 0x7f && !DELIMITERS.has(c)
}

/** The name a function is called by, without the prefix of recent functions, upper case. */
function functionName(word: string): string {
  const upper = upperAscii(word)
  for (const prefix of FUNCTION_PREFIXES) {
    if (upper.startsWith(prefix)) return upper.slice(prefix.length)
  }
  return upper
}

/** Whether a sheet reference (or a 3D one, `S1:S2`) names only sheets of the workbook. */
function sheetsExist(name: string, workbook: WorkbookNames): boolean {
  const lower = foldAscii(name)
  if (workbook.sheets.has(lower)) return true
  const parts = lower.split(':')
  return parts.length === 2 && parts.every((p) => workbook.sheets.has(p))
}

/**
 * What a decoded formula holds that a template may not: nothing when every token is allowed.
 * `workbook` says which sheets, names and tables exist where the formula is (none outside a
 * workbook). One pass over the formula: every character is read a bounded number of times.
 */
export function formulaFindings(
  formula: string,
  workbook: WorkbookNames = NO_WORKBOOK,
): FormulaRefusal[] {
  const found = new Set<FormulaRefusal>()
  const n = formula.length
  let at = 0
  // The last token was a `:` (so a bare column or row is half of a range).
  let afterColon = false
  while (at < n) {
    const c = formula[at] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      at++
      continue
    }
    if (c === '"') {
      // A text: its content is not read. An unterminated one refuses the formula.
      let end = formula.indexOf('"', at + 1)
      while (end >= 0 && formula[end + 1] === '"') end = formula.indexOf('"', end + 2)
      if (end < 0) {
        found.add('template_active_content')
        break
      }
      at = end + 1
      afterColon = false
      continue
    }
    if (c === "'") {
      // A quoted sheet name, `''` for a quote; it must be followed by `!` and name a sheet.
      let name = ''
      let end = at + 1
      for (; end < n; end++) {
        if (formula[end] !== "'") name += formula[end]
        else if (formula[end + 1] === "'") {
          name += "'"
          end++
        } else break
      }
      const dde = formula[at - 1] === '|'
      if (end >= n || formula[end + 1] !== '!') {
        found.add(dde ? 'template_active_content' : 'template_external_link')
        at = end + 1
      } else {
        // A path or a workbook in quotes is never a sheet, whatever the workbook declares.
        if (!dde && (QUOTED_PATH.test(name) || !sheetsExist(name, workbook))) {
          found.add('template_external_link')
        }
        at = end + 2
      }
      afterColon = false
      continue
    }
    if (c === '[') {
      // A bracket not after a table of the workbook: a file name (`[a.xlsx]`, `[1]`).
      found.add('template_external_link')
      at = bracketEnd(formula, at) ?? n
      continue
    }
    if (c === '#') {
      const rest = upperAscii(formula.slice(at, at + 14))
      const error = ERRORS.find((e) => rest.startsWith(e))
      if (error === undefined) {
        found.add('template_active_content')
        at++
      } else {
        at += error.length
      }
      afterColon = false
      continue
    }
    if (c === '|' || c === '!' || c === ']') {
      // A DDE call, or a sheet mark or bracket out of place.
      found.add('template_active_content')
      at++
      continue
    }
    if (OPERATORS.has(c)) {
      afterColon = c === ':'
      at++
      continue
    }
    if (NUMBER_START.test(c) || (c === '.' && NUMBER_START.test(formula[at + 1] ?? ''))) {
      let end = at
      while (end < n && /[0-9.]/.test(formula[end] as string)) end++
      if (
        (formula[end] === 'e' || formula[end] === 'E') &&
        /[-+0-9]/.test(formula[end + 1] ?? '')
      ) {
        end += 2
        while (end < n && NUMBER_START.test(formula[end] as string)) end++
      }
      // A number glued to letters (`1A`) is a word, read below.
      if (end < n && isWordChar(formula[end] as string)) {
        // fall through to the word branch
      } else {
        at = end
        afterColon = false
        continue
      }
    }
    if (!isWordChar(c)) {
      found.add('template_active_content')
      at++
      continue
    }
    let end = at
    while (end < n && isWordChar(formula[end] as string)) end++
    const word = formula.slice(at, end)
    const next = formula[end]
    if (next === '(') {
      const name = functionName(word)
      if (LINKING.has(name)) found.add('template_external_link')
      else if (!PURE.has(name)) found.add('template_active_content')
      at = end
    } else if (next === '!') {
      if (!sheetsExist(word, workbook)) found.add('template_external_link')
      at = end + 1
    } else if (next === '[') {
      // A structured reference, only to a table of the workbook; an unknown table or an open
      // bracket names something outside it. In its brackets only column names and specifiers.
      const { close, clean } = structuredReference(formula, end)
      if (!workbook.tables.has(foldAscii(word)) || close === null) {
        found.add('template_external_link')
      } else if (!clean) {
        found.add('template_active_content')
      }
      at = close ?? n
    } else if (next === ':' && threeDimensional(formula, end) !== null) {
      // A 3D reference `S1:S2!`: both sheets must be of the workbook.
      const after = threeDimensional(formula, end) as number
      const name = formula.slice(at, after - 1)
      if (!sheetsExist(name, workbook)) found.add('template_external_link')
      at = after
    } else {
      const lower = foldAscii(word)
      const range = afterColon || next === ':'
      const allowed =
        lower === 'true' ||
        lower === 'false' ||
        CELL.test(word) ||
        (range && (COLUMN.test(word) || ROW.test(word))) ||
        workbook.names.has(lower)
      if (!allowed) found.add('template_active_content')
      at = end
    }
    afterColon = false
  }
  return (['template_active_content', 'template_external_link'] as const).filter((f) =>
    found.has(f),
  )
}

/**
 * Whether the `:` at `colon` starts the second sheet of a 3D reference (`S1:S2!`): where reading
 * goes on after its `!`, or null (then it is a range). It reads only the second word, so the whole
 * formula stays linear.
 */
function threeDimensional(formula: string, colon: number): number | null {
  let end = colon + 1
  while (end < formula.length && isWordChar(formula[end] as string)) end++
  if (end === colon + 1 || formula[end] !== '!') return null
  return end + 1
}

/** The specifiers of a structured reference, ASCII upper case. */
const STRUCTURED_SPECIFIERS = ['#ALL', '#DATA', '#HEADERS', '#TOTALS', '#THIS ROW']

/** A control character (C0, DEL, C1): never part of a column name. */
/** The characters a `'` may escape in a structured reference (ECMA-376 §18.17.2). */
const STRUCTURED_ESCAPED = new Set(["'", '[', ']', '#'])
/** Besides letters and numbers, what a column name in single brackets may hold. */
const SINGLE_BRACKET = new Set(['_', '.', ' ', '%', '€'])

const isControl = (point: number): boolean => point < 0x20 || (point >= 0x7f && point <= 0x9f)

/**
 * A structured reference opened at `open` (`Table[...]`): where it ends (after its `]`, null when
 * it never closes) and whether it holds only column names and the specifiers `#All #Data
 * #Headers #Totals #This Row` (each right after a `[`), as Excel writes them. In inner brackets a
 * column name is any character but a control one and an unescaped `[ ] # ' @`; in single brackets
 * only letters, numbers, `_`, `.`, space, `%` and `€` (anything else needs `[[…]]`). A `'` escapes
 * only `' [ ] #`. `,` and `:` separate the items of the outer brackets, where a name or a
 * specifier must be the whole reference (`T[Col]`, `T[#All]`). At most two levels. By code point.
 */
function structuredReference(
  formula: string,
  open: number,
): { close: number | null; clean: boolean } {
  let depth = 0
  let clean = true
  // A name or a specifier in the outer brackets, an inner bracket, a separator of the outer ones.
  let bare = false
  let nested = false
  let separated = false
  for (let k = open; k < formula.length; k++) {
    const point = formula.codePointAt(k) as number
    const ch = String.fromCodePoint(point)
    if (point > 0xffff) k++
    if (ch === '[') {
      depth++
      if (depth === 2) nested = true
      if (depth > 2) clean = false
    } else if (ch === ']') {
      depth--
      if (depth === 0) return { close: k + 1, clean: clean && !(bare && (nested || separated)) }
    } else if (depth === 1 && (ch === ',' || ch === ':')) {
      separated = true
    } else if (ch !== ' ') {
      if (depth === 1) bare = true
      if (ch === "'") {
        // An escape, only of the characters that would end or change a name.
        k++
        if (k >= formula.length) return { close: null, clean }
        if (!STRUCTURED_ESCAPED.has(formula[k] as string)) clean = false
        if ((formula.codePointAt(k) as number) > 0xffff) k++
      } else if (ch === '#') {
        const rest = upperAscii(formula.slice(k, k + 9))
        const specifier = STRUCTURED_SPECIFIERS.find((s) => rest.startsWith(s))
        const placed = formula[k - 1] === '[' && formula[k + (specifier?.length ?? 0)] === ']'
        if (specifier === undefined || !placed) clean = false
        else k += specifier.length - 1
      } else if (ch === '@' || isControl(point)) {
        clean = false
      } else if (depth === 1 && !(LETTER_OR_NUMBER.test(ch) || SINGLE_BRACKET.has(ch))) {
        // In single brackets only plain names: anything else needs `[[…]]`, as Excel writes it.
        clean = false
      }
    }
  }
  return { close: null, clean }
}

/**
 * Where a bracketed reference opened at `open` ends (after its `]`): brackets nest and `'`
 * escapes the next character, as in a structured reference. Null when it never closes.
 */
function bracketEnd(formula: string, open: number): number | null {
  let depth = 0
  for (let k = open; k < formula.length; k++) {
    const ch = formula[k]
    if (ch === "'") k++
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return k + 1
  }
  return null
}
