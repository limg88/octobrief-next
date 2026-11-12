// A mail to the client in the shape of the sample recipe: the summary is the body, a subject comes
// first and the recipients are a text parameter. The parameters a run stores are made by the same
// check the production path uses, so they are typed as it types them.

import { checkParameterValues, type ParameterValue } from '../../src/recipe/index.ts'
import { recipeOf } from './client-version.ts'
import { sampleRecipe } from './recipes.ts'

export const MAIL_SUBJECT = 'Aggiornamento sul progetto'

/** The sample recipe whose summary is the body of the mail, after a subject. */
export function mailRecipe(): Record<string, unknown> {
  const recipe = sampleRecipe()
  const summary = recipe.sections.find((s) => s.id === 'summary')
  if (!summary) throw new Error('the sample recipe has no summary')
  summary.id = 'body'
  recipe.sections.unshift({
    id: 'subject',
    title: 'Oggetto',
    required: true,
    version: 'both',
    removable: false,
    blocks: [{ kind: 'static', id: 'subject_line', text: MAIL_SUBJECT }],
  })
  recipe.parameters.push({
    id: 'recipients',
    type: 'text',
    label: 'Destinatari',
    required: false,
    step: 2,
    maxLength: 500,
  })
  return recipe
}

/** The parameters of a run of the mail, as the run stores them. */
export function mailParameters(recipients?: string): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {
    period: { type: 'period', from: '2026-10-01', to: '2026-10-31' },
    request_number: { type: 'number', value: 3 },
    ...(recipients === undefined ? {} : { recipients: { type: 'text', value: recipients } }),
  }
  return { ...checkParameterValues(recipeOf(mailRecipe()), values) }
}
