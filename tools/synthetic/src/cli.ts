// Writes the documents of a synthetic project to a folder: `node src/cli.ts <dir> [seed]`.
// The meeting minutes are also written as a Word file, to show Office extraction.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateDeliveryProject } from './generate.ts'
import { docxFromLines } from './office.ts'

const [target, seedArg] = process.argv.slice(2)
if (!target) {
  console.error('usage: node src/cli.ts <dir> [seed]')
  process.exit(1)
}
const dir = resolve(target)
const project = generateDeliveryProject({ seed: Number(seedArg ?? 1) })
mkdirSync(dir, { recursive: true })
for (const document of project.documents) {
  writeFileSync(join(dir, document.fileName), document.bytes)
  if (document.fileName.startsWith('Verbale-') && document.fileName.endsWith('.md')) {
    const lines = new TextDecoder().decode(document.bytes).split('\n')
    writeFileSync(
      join(dir, document.fileName.replace(/\.md$/, '.docx')),
      docxFromLines(lines.map((line) => line.replace(/^#+\s*/, ''))),
    )
  }
}
console.log(`${project.projectName}: documents written to ${dir}`)
