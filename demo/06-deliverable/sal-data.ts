// Synthetic data for the SAL demo: the documents of a generated project and the values a PM
// would type in the SAL form. Usage: node demo/06-deliverable/sal-data.ts <dir>
// Writes the documents to <dir> and <dir>/sal-parameters.json, where the ids of the uploaded
// documents are still placeholders (ORDER, INVOICE_1, INVOICE_2): the demo fills them in.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { project, salParams } from '../../packages/domain/test/support/delivery-recipes.ts'

const target = process.argv[2]
if (!target) {
  console.error('usage: node demo/06-deliverable/sal-data.ts <dir>')
  process.exit(1)
}
const dir = resolve(target)
const synthetic = project()
mkdirSync(dir, { recursive: true })
for (const document of synthetic.documents) {
  writeFileSync(join(dir, document.fileName), document.bytes)
}
// The invoices are not cited: without the data warehouse connected nothing could confirm them.
const { invoice_docs: _invoices, cited_invoices: _cited, ...values } = salParams(synthetic)
const parameters = {
  ...values,
  order_doc: { type: 'evidence_selection', evidenceIds: ['ORDER'] },
}
writeFileSync(join(dir, 'sal-parameters.json'), JSON.stringify(parameters, null, 2))
const files = synthetic.documents.map((document) => document.fileName)
console.log(
  JSON.stringify({
    order: files.find((name) => name.startsWith('Ordine-')),
    invoices: files.filter((name) => name.startsWith('Fattura-')),
  }),
)
