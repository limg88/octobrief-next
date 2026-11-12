import { expect } from '@playwright/test'
import { start } from './lib.ts'

const base = (process.argv[2] as string).replace(/deliverables$/, '')
const s = await start(`${base}sources`)
const { page } = s
await s.step('8a Fonti: «Jira Borea» con l’ultima lettura, senza errori; Leggi ora', async () => {
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: 'Leggi ora' }).click()
  await page.waitForTimeout(5000)
  await page.reload()
  await page.waitForTimeout(2500)
  const t = await s.text()
  console.log(
    t
      .slice(t.indexOf('Fonte\t'))
      .split('\n')
      .slice(0, 8)
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
  expect(t).toContain('Jira Borea')
  expect(t).not.toContain('non riuscita')
})
await s.step('8b Chiedi «Quanti bug sono aperti?»', async () => {
  await page.goto(`${base}ask`)
  await page.waitForTimeout(2000)
  await page.getByRole('textbox').first().fill('Quanti bug sono aperti?')
  await page.getByRole('button', { name: 'Chiedi', exact: true }).click()
  await page.waitForTimeout(8000)
  console.log(
    (await s.text())
      .split('\n')
      .slice(0, 16)
      .map((l) => `      | ${l.slice(0, 160)}`)
      .join('\n'),
  )
})
await s.done()
