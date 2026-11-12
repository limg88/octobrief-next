import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/** Fails on accessibility problems a person would be blocked or seriously slowed by. */
async function expectAccessible(page: Page): Promise<void> {
  // Redirects and first renders are over before the page is examined.
  await page.waitForLoadState('networkidle')
  const { violations } = await new AxeBuilder({ page }).analyze()
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([])
}

const file = (name: string, text: string) => ({
  name,
  mimeType: 'text/markdown',
  buffer: Buffer.from(text, 'utf8'),
})

test('login, upload two documents that disagree, ask, read a verified answer', async ({ page }) => {
  const project = `E2E ${Date.now()}`

  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Accedi a Octobrief' })).toBeVisible()
  await expectAccessible(page)

  // The fake issuer signs in the synthetic person named by `login_hint`.
  await page.goto('/api/auth/login?login_hint=paola&return_to=/')
  await page.getByRole('button', { name: 'Nuovo progetto' }).first().click()
  await page.getByLabel('Nome del progetto').fill(project)
  await page.getByRole('button', { name: 'Crea progetto' }).click()
  await expect(page.getByRole('heading', { name: project })).toBeVisible()
  await expectAccessible(page)
  const projectUrl = page.url()

  await page.goto(`${projectUrl}/memory`)
  await page
    .locator('input[type=file]')
    .setInputFiles([
      file('SAL-2026-11-04.md', 'Budget complessivo: 890.000 €.\nAvanzamento complessivo: 49%.\n'),
      file(
        'SAL-rev2-2026-11-05.md',
        'Budget complessivo: 950.000 €.\nAvanzamento complessivo: 49%.\n',
      ),
    ])
  const knowledge = page.getByRole('region', { name: 'Cosa ho capito' })
  await expect(knowledge.getByText('Budget complessivo: 950.000 €.').first()).toBeVisible()
  await expect(knowledge.getByText('in contraddizione').first()).toBeVisible()
  await expectAccessible(page)

  await page.goto(`${projectUrl}/ask`)
  await page.getByLabel('La tua domanda').fill('Qual è il budget complessivo?')
  await page.getByRole('button', { name: 'Chiedi' }).click()
  await expect(page.getByRole('heading', { name: 'Qual è il budget complessivo?' })).toBeVisible()
  const contradictions = page.getByRole('region', { name: 'Fonti in contraddizione' })
  await expect(contradictions.getByText('SAL-2026-11-04.md').first()).toBeVisible()
  await expect(contradictions.getByText('SAL-rev2-2026-11-05.md').first()).toBeVisible()
  // Two sentences rest on facts that contradict each other: the checks say so.
  await expect(page.getByText(/\d+ controlli · 2 anomalie/)).toBeVisible()
  await expect(page.getByText("fonte in contraddizione con un'altra (2)")).toBeVisible()
  await expectAccessible(page)

  // The question is in the history, and a figure the model invents is never shown.
  await page.getByLabel('La tua domanda').fill('Qual è il budget complessivo? #inventa')
  await page.getByRole('button', { name: 'Chiedi' }).click()
  await expect(page.getByText('Frase sospesa: nessuna fonte verificata la sostiene.')).toBeVisible()
  await expect(page.getByText('123.456')).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Le tue domande' }).getByRole('listitem'),
  ).toHaveCount(2)
})
