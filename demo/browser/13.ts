import { expect } from '@playwright/test'
import { start } from './lib.ts'

const url = process.argv[2] as string
const s = await start(url)
const { page } = s

await s.step('10 tre fonti alimentate dalla cartella, senza errori', async () => {
  for (const label of [
    'Jira · dalla cartella',
    'Azure DevOps · dalla cartella',
    'Microsoft 365 · dalla cartella',
  ]) {
    await expect(page.getByText(new RegExp(label)).first()).toBeVisible()
  }
  expect(await s.text()).not.toContain('non riuscita')
})
await s.step(
  '11 Memoria: mail e riunione arrivate dalla cartella, con il fatto sul budget',
  async () => {
    await page.goto(url.replace(/sources$/, 'memory'))
    await expect(page.getByText('RE Budget Borea.md').first()).toBeVisible()
    await expect(page.getByText('Allineamento settimanale Borea.md').first()).toBeVisible()
    await expect(page.getByText(/da m365 \(cartella sincronizzata\)/).first()).toBeVisible()
    await expect(page.getByText('Cosa ho capito')).toBeVisible()
    await expect(page.getByText(/890\.000/).first()).toBeVisible()
  },
)
await s.step('12 Chiedi: una domanda sul budget trova la mail', async () => {
  await page.goto(url.replace(/sources$/, 'ask'))
  await page.getByRole('textbox').first().fill('Qual è il budget approvato?')
  await page.getByRole('button', { name: 'Chiedi', exact: true }).click()
  await expect(page.getByText('RE Budget Borea.md').first()).toBeVisible({ timeout: 30_000 })
})
await s.done()
