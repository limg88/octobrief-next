import { expect } from '@playwright/test'
import { start } from './lib.ts'

const base = process.argv[2] as string
const s = await start(`${base}/memory`, 'paola', true)
const { page } = s
await s.step('9a progetto Aurora con i documenti (Memoria)', async () => {
  await page.waitForTimeout(2500)
  const t = await s.text()
  console.log(
    t
      .split('\n')
      .filter((l) => /\.(md|txt)$|Cosa ho capito|Pronto/.test(l))
      .slice(0, 8)
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
  expect(t).toContain('SAL-Borea-2026-11-04.md')
})
await s.step('9b Chiedi: la domanda sul budget con le sue fonti', async () => {
  await page.goto(`${base}/ask`)
  await page.waitForTimeout(2500)
  const t = await s.text()
  console.log(
    t
      .split('\n')
      .slice(3, 16)
      .map((l) => `      | ${l.slice(0, 150)}`)
      .join('\n'),
  )
  expect(t).toContain('Qual è il budget complessivo del progetto?')
  expect(t).toContain('SAL-Borea-2026-11-04.md')
})
await s.step('9c una nuova domanda dal browser (streaming attraverso Caddy)', async () => {
  await page.getByRole('textbox').first().fill('Quando è prevista la fine del progetto?')
  await page.getByRole('button', { name: 'Chiedi', exact: true }).click()
  await expect(page.getByText(/15 dicembre 2026/).first()).toBeVisible({ timeout: 30000 })
})
await s.done()
