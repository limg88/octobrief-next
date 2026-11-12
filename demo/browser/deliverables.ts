// deliv.ts <deliverables url> <expected text 1> <expected text 2> …: opens every document of the project.
import { start } from './lib.ts'

const [url = '', ...expected] = process.argv.slice(2)
const s = await start(url, 'paola', url.startsWith('https'))
const { page } = s
await page.waitForTimeout(2500)
let all = ''
await s.step('catalogo e documenti del progetto', async () => {
  const t = await s.text()
  all += t
  const i = t.indexOf('Documenti del progetto')
  console.log(
    t
      .slice(i)
      .split('\n')
      .slice(0, 12)
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
})
const section = {
  getByRole: () =>
    page
      .getByRole('button')
      .filter({ hasText: /Approvato|Da rivedere|Non riuscit|In preparazione|In coda/ }),
}
const count = await section.getByRole().count()
for (let i = 0; i < count; i++) {
  await s.step(`documento ${i + 1}`, async () => {
    await section.getByRole().nth(i).click()
    await page.waitForTimeout(1800)
    const t = await s.text()
    all += t
    const at = t.lastIndexOf('revisione')
    console.log(
      t
        .slice(Math.max(0, at - 60))
        .split('\n')
        .slice(0, Number(process.env.LINES ?? 28))
        .map((l) => `      | ${l.slice(0, 190)}`)
        .join('\n'),
    )
    for (const link of await page
      .getByRole('link')
      .filter({ hasText: /\.(md|docx|xlsx|pptx)/ })
      .all()) {
      const href = await link.getAttribute('href')
      const res = await page.request.get(new URL(href as string, url).toString())
      const body = await res.body()
      console.log(
        `      | file ${await link.innerText()} → ${res.status()} ${body.length} byte ${body.subarray(0, 2).toString() === 'PK' ? '(zip Office)' : ''}`,
      )
      if (res.status() !== 200) throw new Error('download fallito')
    }
    await s.shot(`deliv-${i + 1}`)
  })
}
await s.step('testi attesi dal copione', async () => {
  const missing = expected.filter((e) => !all.includes(e))
  if (missing.length) throw new Error(`mancano: ${missing.join(' | ')}`)
})
await s.done()
