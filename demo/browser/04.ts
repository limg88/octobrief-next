import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s

await s.step('10 tabella con le tre fonti', async () => {
  for (const name of ['Posta e riunioni', 'Cartella di progetto', 'Jira Borea']) {
    await expect(page.getByText(name).first()).toBeVisible()
  }
  console.log(
    (await s.text())
      .split('\n')
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
})
await s.step('11a Leggi ora su Jira Borea: lettura riuscita', async () => {
  const row = page.locator('tr, li, article').filter({ hasText: 'Jira Borea' }).last()
  await row.getByRole('button', { name: 'Leggi ora' }).click()
  await page.waitForTimeout(6000)
  await page.reload()
  await page.waitForLoadState('networkidle')
  const text = await s.text()
  console.log(
    text
      .split('\n')
      .filter((l) => /Jira|riuscita|lettura/i.test(l))
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
  expect(text).not.toContain('non riuscita')
})
await s.step('11b Nuovo token su Posta e riunioni: riquadro col token', async () => {
  const row = page.locator('tr, li, article').filter({ hasText: 'Posta e riunioni' }).last()
  await row.getByRole('button', { name: 'Nuovo token' }).click()
  await page.waitForTimeout(1500)
  await s.shot('04-token')
  const text = await page.locator('body').innerText()
  console.log(
    text
      .split('\n')
      .filter((l) => /token/i.test(l))
      .slice(0, 6)
      .map((l) => `      | ${l.slice(0, 160)}`)
      .join('\n'),
  )
  expect(text).toMatch(/copia/i)
})
await s.step('12 Memoria (G poi M): provenienza dei documenti e fatti', async () => {
  await page.keyboard.press('Escape')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('g')
  await page.keyboard.press('m')
  await page.waitForURL(/\/memory/)
  await page.waitForLoadState('networkidle')
  for (const from of [
    'da Posta e riunioni',
    'da Cartella di progetto',
    'da Jira Borea',
    'Cosa ho capito',
  ]) {
    await expect(page.getByText(from).first()).toBeVisible()
  }
  await s.shot('04-memoria')
})
await s.done()
