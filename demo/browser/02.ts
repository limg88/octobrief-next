import { readdirSync } from 'node:fs'
import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s
const dir = '.tmp/demo-02-docs'
const pick = (re: RegExp) => `${dir}/${readdirSync(dir).find((f) => re.test(f))}`
await s.step('9 tabella con SAL e verbale, avviso «da confermare»', async () => {
  await expect(page.getByText('da confermare').first()).toBeVisible()
  console.log(
    (await s.text())
      .split('\n')
      .filter((l) => /\.(md|docx|pdf|csv|vtt|txt|xlsx)$/.test(l))
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
  console.log(`      files: ${readdirSync(dir).join(', ')}`)
})
await s.step(
  '10 carica Backlog csv: «caricato», poi Pronto senza ricaricare; duplicato rifiutato',
  async () => {
    const f = pick(/Backlog.*\.csv$/)
    await page.locator('input[type=file]').setInputFiles(f)
    await expect(page.getByText(/caricato/).first()).toBeVisible()
    const row = page.locator('tr').filter({ hasText: 'Backlog-Borea' })
    await expect(row.getByText('Pronto')).toBeVisible({ timeout: 30000 })
    await page.locator('input[type=file]').setInputFiles(f)
    await expect(page.getByText('Il progetto contiene già questo file')).toBeVisible()
  },
)
for (const r of await page.locator('tbody tr').all()) {
  const cells = await r.locator('td').all()
  const out: string[] = []
  for (const c of cells)
    out.push((await c.innerText()).includes('da confermare') ? 'DA CONFERMARE' : '-')
  console.log(
    `      | ${(await r.locator('td').first().innerText()).split('\n')[0]}: ${out.join(' ')}`,
  )
}
await s.step(
  '11 cambia il tipo: «da confermare» sparisce; «Vedi testo» mostra i brani',
  async () => {
    const name = 'Verbale-riunione-Borea-2026-11-05.docx'
    const before = await page
      .locator('tr')
      .filter({ hasText: name })
      .getByText('da confermare')
      .count()
    await page
      .locator('tr')
      .filter({ hasText: name })
      .locator('select')
      .nth(1)
      .selectOption({ label: 'Cliente' })
    await page.waitForTimeout(1500)
    const after = await page
      .locator('tr')
      .filter({ hasText: name })
      .getByText('da confermare')
      .count()
    console.log(`      | ${name}: da confermare ${before} → ${after}`)
    if (after >= before) throw new Error('avviso non sparito')
    await page
      .locator('tr')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Vedi testo' })
      .click()
    await expect(page.getByText(/righe \d|§ \d/).first()).toBeVisible()
    await s.shot('02-testo')
    await page.keyboard.press('Escape')
  },
)
await s.step('12 elimina: «eliminato» e la riga sparisce', async () => {
  await page.getByRole('button', { name: 'Elimina Backlog-Borea-2026-11-05.csv' }).click()
  await expect(page.getByText(/eliminato/).first()).toBeVisible()
  await expect(page.locator('tr').filter({ hasText: 'Backlog-Borea' })).toHaveCount(0)
})
await s.done()
