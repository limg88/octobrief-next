import { describe, expect, it } from 'vitest'
import {
  diffRecipes,
  RECIPE_CHANGE_CODES,
  type Recipe,
  recipeText,
  validateRecipe,
} from '../src/recipe/index.ts'
import { sampleRecipe } from './support/recipes.ts'

type Raw = ReturnType<typeof sampleRecipe>

const valid = (input: unknown): Recipe => {
  const v = validateRecipe(input)
  if (!v.ok) throw new Error(JSON.stringify(v.errors))
  return v.recipe
}

const texts = (a: Raw, b: Raw) => diffRecipes(valid(a), valid(b), 'it').map((c) => c.text)

const blockOf = (r: Raw, id: string) => {
  for (const s of r.sections) {
    const b = s.blocks.find((x) => x.id === id)
    if (b) return b as Record<string, unknown> & { columns: Array<Record<string, unknown>> }
  }
  throw new Error(id)
}

describe('diffRecipes', () => {
  it('finds no difference between a recipe and itself', () => {
    expect(texts(sampleRecipe(), sampleRecipe())).toEqual([])
  })

  it('describes a section added between two versions in PM words', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.sections.splice(2, 0, {
      id: 'risks',
      title: 'Rischi',
      required: false,
      version: 'both',
      removable: true,
      blocks: [
        {
          kind: 'text_slot',
          id: 'risks_text',
          instructions: 'Elenca i rischi aperti.',
          natures: ['fact'],
          maxChars: 800,
        },
      ],
    })
    expect(texts(a, b)).toEqual(['Aggiunta la sezione “Rischi”.'])
  })

  it('says a check now applies to more, by the names of what it looks at', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    const coverage = (coveredBy: unknown[]) => ({
      id: 'all_attributed',
      kind: 'coverage',
      label: 'tutto attribuito',
      message: 'Qualche elemento non è attribuito.',
      universe: { block: 'features', column: 'id' },
      coveredBy,
      allowUnassigned: false,
      exclusive: false,
    })
    a.checks.push(coverage([{ block: 'positions', column: 'item' }]))
    b.checks.push(
      coverage([
        { block: 'positions', column: 'item' },
        { block: 'hours', column: 'employee' },
      ]),
    )
    expect(texts(a, b)).toEqual(['Il controllo “tutto attribuito” ora vale anche per “Persona”.'])
  })

  it('says when a check looks at something else, or changed otherwise', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.checks[0] = { ...b.checks[0], column: { block: 'positions', column: 'invoiced' } }
    b.checks[1] = { ...b.checks[1], maxChars: 600 }
    expect(texts(a, b)).toEqual([
      "Il controllo “somma delle posizioni” ora vale per “Fatturato”, “Totale dell'ordine”.",
      'Cambiato il controllo “sintesi breve”.',
    ])
  })

  it('describes removed and moved sections, and changes of the sections', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    const team = b.sections.pop()
    const progress = b.sections.pop()
    if (!team || !progress) throw new Error()
    b.sections.unshift(progress)
    const summary = b.sections.find((s) => s.id === 'summary')
    if (!summary) throw new Error()
    summary.title = 'Sintesi'
    summary.required = false
    summary.removable = true
    summary.version = 'internal'
    expect(texts(a, b)).toEqual([
      'Tolta la sezione “Consuntivo del team”.',
      'Spostata la sezione “Avanzamento”.',
      'La sezione “Sintesi del periodo «Periodo del SAL»” ora si chiama “Sintesi”.',
      'La sezione “Sintesi” ora è facoltativa.',
      'La sezione “Sintesi” ora è solo nella versione interna.',
      'La sezione “Sintesi” ora si può togliere dal progetto.',
    ])
  })

  it('describes changes of blocks, columns and values', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    const positions = blockOf(b, 'positions')
    positions.columns.splice(1, 1)
    positions.columns.push({
      id: 'qty',
      title: 'Quantità',
      from: { kind: 'field', field: 'quantity' },
      category: 'contract_amounts',
    })
    ;(positions.columns[0] as Record<string, unknown>).category = 'costs'
    blockOf(b, 'order_total').category = 'margins'
    blockOf(b, 'summary_text').instructions = 'Riassumi in tre righe.'
    blockOf(b, 'intro').text = 'Ecco lo stato.'
    const summary = b.sections.find((s) => s.id === 'summary')
    summary?.blocks.push({ kind: 'static', id: 'outro', text: 'Restiamo a disposizione.' })
    blockOf(b, 'hours').query = {
      kind: 'system_rows',
      view: 'v_timesheet_all',
      where: [{ column: 'tipoore', equals: 'ordinarie' }],
    }
    expect(texts(a, b)).toEqual([
      'Nella sezione “Sintesi del periodo «Periodo del SAL»” aggiunto “Sintesi del periodo «Periodo del SAL»”.',
      'Nella tabella “Posizioni” aggiunta la colonna “Quantità”.',
      'Nella tabella “Posizioni” tolta la colonna “Voce”.',
      'La colonna “Riga” ora è trattata come costi.',
      "Il valore “Totale dell'ordine” ora è trattato come margini.",
      'Nella sezione “Sintesi del periodo «Periodo del SAL»” cambiato “Sintesi del periodo «Periodo del SAL»”.',
      'Nella sezione “Sintesi del periodo «Periodo del SAL»” cambiate le istruzioni per “Sintesi del periodo «Periodo del SAL»”.',
      'Nella sezione “Consuntivo del team” cambiato “Ore”.',
    ])
  })

  it('describes parameters, prerequisites, rules, categories and render', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.title = 'SAL'
    b.purpose = 'Altro scopo.'
    b.audience = 'client'
    b.parameters[0] = { ...b.parameters[0], required: false }
    b.parameters[1] = { ...b.parameters[1], min: 2 }
    b.parameters.splice(2, 1)
    b.parameters.push({
      id: 'ref',
      type: 'date',
      label: 'Data di riferimento',
      required: true,
      step: 3,
    })
    b.prerequisites[0] = {
      ...b.prerequisites[0],
      level: 'if_present',
      freshness: { warnAfterHours: 6, stopAfterHours: 24 },
    }
    b.prerequisites[1] = { kind: 'fact', factKind: 'risk', level: 'required' }
    b.rules = ['Usa il tu.']
    b.redTeamRules = [
      'Nessun «nessun blocco» se ci sono blocchi attivi.',
      'Nessuna scadenza non dichiarata.',
    ]
    b.extraInternalCategories = [{ block: 'positions', column: 'item', category: 'costs' }]
    b.render = { formats: ['md', 'docx'], template: 'neutro', sections: [], namedCells: [] }
    b.examples = []
    b.checks.pop()
    b.checks.push({
      id: 'present_total',
      kind: 'present',
      label: 'totale presente',
      message: 'Manca il totale.',
      block: 'order_total',
    })
    expect(texts(a, b)).toEqual([
      'Il nome della ricetta passa da “SAL economico” a “SAL”.',
      'Cambiato lo scopo della ricetta.',
      'Ora la ricetta produce la versione per il cliente.',
      'Aggiunto il dato da chiedere “Data di riferimento”.',
      'Tolto il dato da chiedere “Nota per il cliente”.',
      'Il dato “Periodo del SAL” ora è facoltativo.',
      'Cambiato il dato da chiedere “Numero della richiesta”.',
      'Ora servono dati da: rischi.',
      'Non servono più dati da: contratti.',
      'I dati da sistema amministrativo ora si usano solo se ci sono.',
      'Per sistema amministrativo l’avviso di aggiornamento ora scatta dopo 6 ore e il blocco dopo 24 ore.',
      'Aggiunto il controllo “totale presente”.',
      'Tolto il controllo “sintesi breve”.',
      'Aggiunta la regola di scrittura: «Usa il tu.».',
      'Tolta la regola di scrittura: «Scrivi frasi brevi e concrete.».',
      'Aggiunto il controllo del revisore: «Nessuna scadenza non dichiarata.».',
      'Il dato “Voce” ora è trattato come costi.',
      'Ora la ricetta produce anche un documento Word.',
      'La ricetta non produce più un foglio Excel.',
      'Cambiato il modello grafico del file.',
      'Cambiata l’impaginazione del file.',
      'Cambiati gli esempi della ricetta.',
    ])
  })

  it('says a block moved to another section, and which', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    const total = b.sections[0]?.blocks.pop()
    if (!total) throw new Error()
    b.sections[1]?.blocks.push(total)
    expect(texts(a, b)).toEqual([
      "“Totale dell'ordine” passa dalla sezione “Posizioni dell'ordine” alla sezione “Sintesi del periodo «Periodo del SAL»”.",
    ])
  })

  it('says a block changed place within its section', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.sections[1]?.blocks.reverse()
    expect(texts(a, b)).toEqual([
      'Nella sezione “Sintesi del periodo «Periodo del SAL»” spostato “Sintesi del periodo «Periodo del SAL»”.',
    ])
  })

  it('says the columns of a table changed order, and nothing else', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    blockOf(b, 'positions').columns.reverse()
    expect(texts(a, b)).toEqual(['Nella tabella “Posizioni” cambiato l’ordine delle colonne.'])
  })

  it('never says nothing when the recipe changed', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.slug = 'sal-economico-bis'
    expect(texts(a, b)).toEqual(['Cambiato un dettaglio della ricetta.'])
    const c = sampleRecipe()
    c.version = '1.1.0'
    expect(texts(a, c)).toEqual([])
  })

  it('never writes identifiers or JSON', () => {
    const a = sampleRecipe()
    const b = sampleRecipe()
    b.sections.reverse()
    b.checks.reverse()
    for (const t of texts(a, b)) expect(t).not.toMatch(/[{}[\]]|_|sha256/)
  })

  it('has an Italian text for every kind of change', () => {
    for (const code of RECIPE_CHANGE_CODES) {
      const text = recipeText(
        'changes',
        code,
        {
          name: 'X',
          section: 'S',
          from: 'A',
          to: 'B',
          block: 'T',
          targets: '“Y”',
          text: 'r',
          category: 'costs',
          audience: 'both',
          version: 'client',
          format: 'pptx',
          warn: 12,
          stop: 24,
        },
        'it',
      )
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toMatch(/[{}]|_/)
    }
    expect(() => recipeText('changes', 'nothing', {}, 'it')).toThrow()
  })
})
