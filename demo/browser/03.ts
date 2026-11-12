import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s
await s.step('10 «Cosa ho capito»: fatti per tipo con brano, file e posizione', async () => {
  await expect(page.getByText('Cosa ho capito')).toBeVisible()
  const t = await s.text()
  const part = t.slice(t.indexOf('Cosa ho capito'))
  console.log(
    part
      .split('\n')
      .slice(0, 30)
      .map((l) => `      | ${l.slice(0, 150)}`)
      .join('\n'),
  )
  for (const g of ['Stato', 'Milestone', 'Rischi', 'Azioni', 'Economia']) expect(part).toContain(g)
})
await s.step('11 ricarica la revisione: «ancora in lettura», poi «in contraddizione»', async () => {
  await page
    .locator('input[type=file]')
    .setInputFiles('.tmp/demo-03-docs/SAL-Borea-rev2-2026-11-05.md')
  await expect(page.getByText(/ancora in lettura/)).toBeVisible()
  await expect(page.getByText('in contraddizione').first()).toBeVisible({ timeout: 40000 })
  await s.shot('03-contraddizione')
})
await s.step('12 elimina la revisione: il budget torna uno, etichetta sparita', async () => {
  await page.getByRole('button', { name: 'Elimina SAL-Borea-rev2-2026-11-05.md' }).click()
  await expect(page.getByText('in contraddizione')).toHaveCount(0, { timeout: 30000 })
})
await s.done()
