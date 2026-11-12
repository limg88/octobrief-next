import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  foldAscii,
  formulaFindings,
  isDefinedName,
  isSheetName,
  LINKING_FUNCTIONS,
  PURE_FUNCTIONS,
  type WorkbookNames,
} from '../src/recipe/index.ts'
import { growthSlope, MAX_GROWTH_SLOPE, TIMING_TEST_TIMEOUT_MS } from './timing.ts'

// The formula cases are shared with the renderer (`apps/renderer/tests/test_formula.py` reads the
// same file), so both gates answer every formula the same way.
const CASES = new URL('./fixtures/formulas.json', import.meta.url)
const FUNCTIONS = new URL('../schemas/formula-functions.json', import.meta.url)

interface FormulaCases {
  workbook: { sheets: string[]; names: string[]; tables: string[] }
  cases: { formula: string; refusals: string[] }[]
  names: { name: string; sheet: boolean; defined: boolean }[]
}

const shared = JSON.parse(readFileSync(CASES, 'utf8')) as FormulaCases
const workbook: WorkbookNames = {
  sheets: new Set(shared.workbook.sheets),
  names: new Set(shared.workbook.names),
  tables: new Set(shared.workbook.tables),
}

describe('the formulas a template may hold', () => {
  it('answers every shared case as the renderer does', () => {
    expect(shared.cases.length).toBeGreaterThan(60)
    for (const c of shared.cases) {
      expect(formulaFindings(c.formula, workbook), c.formula).toEqual(c.refusals)
    }
  })

  it('judges sheet, defined and table names as the renderer does, by the rules of Excel', () => {
    expect(shared.names.length).toBeGreaterThan(20)
    for (const c of shared.names) {
      expect(isSheetName(c.name), `sheet ${c.name}`).toBe(c.sheet)
      expect(isDefinedName(c.name), `name ${c.name}`).toBe(c.defined)
    }
  })

  it('folds only ASCII letters, so a Kelvin sign or a long s is never a letter it looks like', () => {
    expect(foldAscii('KPI Città')).toBe('kpi città')
    expect(foldAscii('KPI')).toBe('Kpi')
    expect(formulaFindings('ſum(1)')).toEqual(['template_active_content'])
    expect(formulaFindings('KPI!A1', workbook)).toEqual(['template_external_link'])
    expect(formulaFindings('KPI!A1', workbook)).toEqual([])
  })

  it('refuses a quoted path or workbook as a sheet even when the workbook declares it', () => {
    for (const formula of ["'[1]S'!A1", "'a/b'!A1", "'\\\\evil\\s\\[a.xlsx]S'!A1"]) {
      expect(formulaFindings(formula, workbook), formula).toEqual(['template_external_link'])
    }
  })

  it('reads only column names and specifiers in a structured reference', () => {
    expect(formulaFindings('Tabella1[[#Data],[Voce]:[Importo]]', workbook)).toEqual([])
    expect(formulaFindings('Tabella1[\'],INDIRECT("x")]', workbook)).toEqual([
      'template_active_content',
    ])
    expect(formulaFindings('Tabella1[#Alle]', workbook)).toEqual(['template_active_content'])
  })

  it('accepts a sum, a condition and a lookup on its own sheets', () => {
    for (const formula of [
      'SUM(A1:A3)',
      'IF(Foglio1!B2>0,"sì","no")',
      'VLOOKUP(A1,Foglio1!$A$1:$C$10,2,FALSE)',
    ]) {
      expect(formulaFindings(formula, workbook), formula).toEqual([])
    }
  })

  it('refuses outside a workbook every sheet, name and table', () => {
    expect(formulaFindings('Foglio1!A1')).toEqual(['template_external_link'])
    expect(formulaFindings('Totale*2')).toEqual(['template_active_content'])
    expect(formulaFindings('SUM(A1:A3)')).toEqual([])
  })

  it('is written for the renderer as the core lists it', () => {
    const file = JSON.parse(readFileSync(FUNCTIONS, 'utf8'))
    expect(file).toEqual({ pure: [...PURE_FUNCTIONS], linking: [...LINKING_FUNCTIONS] })
    for (const f of LINKING_FUNCTIONS) expect(PURE_FUNCTIONS).not.toContain(f)
  })

  it(
    'reads pathological formulas of 80,000 characters in linear time',
    () => {
      const FULL = 80_000
      for (const piece of [
        "'",
        "'a''",
        '[',
        '[a.b]',
        "[a]'",
        "[a.x]Sheet'",
        '|a',
        '[[[[',
        '"',
        '""',
        'A:',
        'A1:A1:',
        'SUM(',
        '#',
        'Table1[',
        'a!',
        'Tabella1[',
        'Tabella1[[',
        "Tabella1['",
        'Tabella1[#',
      ]) {
        const { slope } = growthSlope((fraction) => {
          const formula = piece.repeat(Math.max(1, Math.round((FULL * fraction) / piece.length)))
          return () => formulaFindings(formula, workbook)
        })
        expect(slope, piece).toBeLessThan(MAX_GROWTH_SLOPE)
      }
    },
    TIMING_TEST_TIMEOUT_MS,
  )
})
