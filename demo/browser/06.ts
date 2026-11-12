import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s
const show = async (n = 45) =>
  console.log(
    (await s.text())
      .split('\n')
      .slice(0, n)
      .map((l) => `      | ${l.slice(0, 150)}`)
      .join('\n'),
  )
const main = async (from: string, n = 40) => {
  const t = await s.text()
  const i = Math.max(0, t.lastIndexOf(from))
  console.log(
    t
      .slice(i)
      .split('\n')
      .slice(0, n)
      .map((l) => `      | ${l.slice(0, 170)}`)
      .join('\n'),
  )
}
const head = async () => {
  const t = await s.text()
  const i = t.lastIndexOf('revisione')
  console.log(
    t
      .slice(Math.max(0, i - 40))
      .split('\n')
      .slice(0, 14)
      .map((l) => `      | ${l.slice(0, 170)}`)
      .join('\n'),
  )
}
await s.step('10 catalogo delle ricette e i due documenti approvati', async () => {
  await page.waitForTimeout(2000)
  await show(40)
})
await s.step(
  '11 apri «SAL economico»: Approvato, file, controlli, anomalia accettata, documento',
  async () => {
    await page.getByText('SAL economico').last().click()
    await page.waitForTimeout(2000)
    await show(60)
    await s.shot('06-sal')
    const t = await s.text()
    expect(t).toContain('Approvato')
  },
)
await s.step('12a «Mail al cliente»: modulo', async () => {
  await page.goto(process.argv[2] as string)
  await page.waitForLoadState('networkidle')
  await page.getByText('Mail al cliente').first().click()
  await page.waitForTimeout(1500)
  await show(50)
  await s.shot('06-form')
})
await s.step('12b compila e prepara: fasi, poi anomalia', async () => {
  await page.getByLabel(/Tipo di comunicazione/).selectOption({ label: 'Richiesta di decisione' })
  await page.getByLabel(/Cosa si chiede/).fill('Confermare la data del collaudo')
  await page.getByLabel(/A chi si chiede/).fill('Carla Cliente')
  const due = page.getByLabel(/Entro quando/)
  console.log(`      | tipo campo data: ${await due.getAttribute('type')}`)
  await due.fill('2026-11-20')
  await page.getByRole('button', { name: 'Prepara il documento' }).click()
  const seen = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const t = await page.locator('body').innerText()
    for (const ph of ['Raccolgo i dati', 'Scrivo i testi', 'Controllo il documento'])
      if (t.includes(ph)) seen.add(ph)
    if (/Anomalie|anomalia aperta|nessuna anomalia/.test(t) && i > 10) break
    await page.waitForTimeout(100)
  }
  console.log(`      | fasi viste: ${[...seen].join(', ')}`)
  await page.waitForTimeout(1500)
  await main('Documenti del progetto', 45)
  await s.shot('06-bozza')
})
await s.step('12c Chiedi modifica → nuova revisione senza anomalie aperte', async () => {
  await page.getByRole('textbox').first().fill("Togli il totale dall'oggetto: non è nelle fonti.")
  await page.getByRole('button', { name: 'Chiedi modifica' }).first().click()
  await expect(page.getByText(/revisione 2/)).toBeVisible({ timeout: 60000 })
  await page.waitForTimeout(1500)
  await head()
})
await s.step('12d Approva → Approvato e file', async () => {
  const approve = page.getByRole('button', { name: 'Approva', exact: true })
  console.log(`      | Approva abilitato: ${await approve.isEnabled()}`)
  await approve.click()
  await expect(page.getByText(/Approvato · revisione 2/)).toBeVisible({ timeout: 60000 })
  await page.waitForTimeout(1500)
  await head()
  await s.shot('06-approvato')
})
await s.done()
