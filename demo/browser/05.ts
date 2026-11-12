import { expect } from '@playwright/test'
import { start } from './lib.ts'

const s = await start(process.argv[2] as string)
const { page } = s
await s.step('9 storico delle 4 domande e ultima risposta al centro', async () => {
  await page.waitForTimeout(2000)
  const t = await s.text()
  console.log(
    t
      .split('\n')
      .slice(0, 40)
      .map((l) => `      | ${l.slice(0, 140)}`)
      .join('\n'),
  )
  await s.shot('05-ask')
})
await s.step(
  '10 prima domanda sul budget: Fatto, Datato, versione più recente, Fonti in contraddizione, controlli',
  async () => {
    await page
      .getByText('Qual è il budget complessivo del progetto?', { exact: true })
      .last()
      .click()
    await page.waitForTimeout(1500)
    const t = await s.text()
    for (const x of [
      'Fatto',
      'Datato',
      'esiste una versione più recente',
      'Fonti in contraddizione',
    ])
      expect(t).toContain(x)
    expect(t).toMatch(/controll/i)
    await s.shot('05-budget')
  },
)
await s.step('11 nuova domanda: fasi e risposta', async () => {
  await page.getByRole('textbox').first().fill('Quali rischi segnala il fornitore?')
  await page.getByRole('button', { name: 'Chiedi', exact: true }).click()
  const seen = new Set<string>()
  for (let i = 0; i < 60; i++) {
    const t = await page.locator('body').innerText()
    for (const ph of ['In coda', 'Sto leggendo', 'Sto verificando'])
      if (t.includes(ph)) seen.add(ph)
    if (/ritardo|Delta/.test(t) && !/In coda|Sto leggendo|Sto verificando/.test(t)) break
    await page.waitForTimeout(100)
  }
  console.log(`      | fasi viste: ${[...seen].join(', ')}`)
  await page.waitForTimeout(1500)
  const t = await s.text()
  console.log(
    t
      .split('\n')
      .slice(0, 25)
      .map((l) => `      | ${l.slice(0, 140)}`)
      .join('\n'),
  )
  await s.shot('05-nuova')
})
await s.done()
