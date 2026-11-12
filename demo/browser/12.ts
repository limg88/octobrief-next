import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s

await s.step('9 le due fonti, ognuna con il suo modo', async () => {
  await expect(page.getByText(/Jira · dalla cartella/).first()).toBeVisible()
  await expect(page.getByText(/Microsoft 365 · dalla cartella/).first()).toBeVisible()
})
await s.step('10 Leggi ora su Jira: lettura avviata e ora aggiornata', async () => {
  const row = page.locator('tr').filter({ hasText: 'Jira (cartella sincronizzata)' })
  const before = await row.locator('td').nth(2).innerText()
  await page.waitForTimeout(61_000 - (Date.now() % 60_000))
  await row.getByRole('button', { name: 'Leggi ora' }).click()
  await expect(page.getByText('Lettura avviata')).toBeVisible()
  await page.waitForTimeout(5000)
  await page.reload()
  await expect(page.getByText(/Jira · dalla cartella/).first()).toBeVisible()
  const after = await page
    .locator('tr')
    .filter({ hasText: 'Jira (cartella sincronizzata)' })
    .locator('td')
    .nth(2)
    .innerText()
  console.log(`      | ultima consegna: ${before} → ${after}`)
  if (after === before) throw new Error('la fonte non è stata riletta')
  expect(await s.text()).not.toContain('non riuscita')
})
await s.step('11 cartella inviata dal PC: blocco push e riga del file .env', async () => {
  const form = page.locator('form').filter({ hasText: 'Collega una cartella sincronizzata' })
  await form.getByLabel('Come arriva la cartella').selectOption('push')
  for (const system of ['Jira', 'Azure DevOps', 'Microsoft 365', 'NetSuite']) {
    await form.getByLabel(system, { exact: true }).uncheck()
  }
  await form.getByLabel('Altri file').check()
  await form.getByRole('button', { name: 'Collega la cartella' }).click()
  await expect(page.getByText(/Da copiare ora nella configurazione/)).toBeVisible()
  const text = await page.locator('body').innerText()
  expect(text).toContain('"tokenEnv": "OCTOBRIEF_TOKEN_FILES"')
  expect(text).toMatch(/OCTOBRIEF_TOKEN_FILES=obf_/)
  await s.shot('12-push')
})
await s.done()
