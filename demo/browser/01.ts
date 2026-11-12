import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start('http://127.0.0.1:3310/', 'marco')
const { page } = s
const cmdk = async () => {
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(400)
}
await s.step('8 login manuale: Accedi con Microsoft → Accesso di prova → Paola Prova', async () => {
  await page.context().clearCookies()
  await page.goto('http://127.0.0.1:3310/')
  await page
    .getByRole('link', { name: /Accedi con Microsoft/ })
    .or(page.getByRole('button', { name: /Accedi con Microsoft/ }))
    .first()
    .click()
  await expect(page.getByText('Accesso di prova')).toBeVisible()
  await page.getByText('Paola Prova').first().click()
  await page.waitForURL(/127\.0\.0\.1:3310/)
  await expect(page.getByRole('button', { name: 'Nuovo progetto' }).first()).toBeVisible()
})
await s.step('9 Nuovo progetto «Migrazione ERP», cliente «Beta Sintetica»', async () => {
  await page.getByRole('button', { name: 'Nuovo progetto' }).first().click()
  await page.getByLabel('Nome del progetto').fill(`Migrazione ERP ${Date.now() % 10000}`)
  await page.getByLabel(/Cliente/).fill('Beta Sintetica')
  await page.getByRole('button', { name: 'Crea progetto' }).click()
  await expect(page.getByText(/Progetto «.*» creato/)).toBeVisible()
  await expect(page.getByText('Responsabile').first()).toBeVisible()
})
await s.step('10 aggiungi Marco fra i membri', async () => {
  await page
    .getByPlaceholder(/@|email/i)
    .or(page.getByLabel(/email/i))
    .first()
    .fill('marco.esempio@example.test')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Marco Esempio').first()).toBeVisible()
  await expect(page.getByText('Membro', { exact: true }).first()).toBeVisible()
})
await s.step('11 ⌘K «memo» Invio → Memoria; G C → Chiedi', async () => {
  await cmdk()
  await page.keyboard.type('memo')
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/memory/)
  await page.locator('body').click({ position: { x: 700, y: 5 } })
  await page.keyboard.press('g')
  await page.keyboard.press('c')
  await page.waitForURL(/\/ask/)
  console.log(`      | ${(await s.text()).split('\n').slice(0, 4).join(' / ').slice(0, 300)}`)
})
await s.step('12 ⌘K Switch to English, tema, Sign out', async () => {
  await cmdk()
  await page.keyboard.type('english')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Ask|Memory|Overview/).first()).toBeVisible()
  const before = await page.locator('html').getAttribute('class')
  await page.waitForTimeout(1500)
  await cmdk()
  await page.keyboard.type('toggle')
  await expect(page.getByText('Toggle light/dark theme')).toBeVisible()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const after = await page.locator('html').getAttribute('class')
  if (before === after) throw new Error(`tema non cambiato: ${before}`)
  await s.shot('01-en')
  await page
    .getByRole('button', { name: /Paola Prova/ })
    .first()
    .click()
  await page.getByText('Sign out').click()
  await page.waitForURL(/\/login/)
})
await s.done()
