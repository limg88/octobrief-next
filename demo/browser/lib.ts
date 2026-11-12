// Scratch harness: follows the browser part of a demo script in a real browser.
import { type Browser, chromium, type Page } from '@playwright/test'

export interface Session {
  page: Page
  problems: string[]
  step(name: string, action: () => Promise<void>): Promise<void>
  text(): Promise<string>
  shot(name: string): Promise<void>
  done(): Promise<void>
}

export async function start(url: string, person = 'paola', ignoreTls = false): Promise<Session> {
  const browser: Browser = await chromium.launch()
  const context = await browser.newContext({
    locale: 'it-IT',
    ignoreHTTPSErrors: ignoreTls,
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const problems: string[] = []
  page.on('dialog', (d) => {
    console.log(`      | conferma: ${d.message()}`)
    void d.accept()
  })
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`))
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()} ${r.request().method()} ${r.url()}`)
  })
  const target = new URL(url)
  await page.goto(
    `${target.origin}/api/auth/login?login_hint=${person}&return_to=${encodeURIComponent(target.pathname)}`,
  )
  await page.waitForLoadState('networkidle')
  let failed = 0
  return {
    page,
    problems,
    async step(name, action) {
      try {
        await action()
        console.log(`  ✔ ${name}`)
      } catch (error) {
        failed += 1
        console.log(
          `  ✘ ${name}\n      ${(error as Error).message.split('\n').slice(0, 4).join('\n      ')}`,
        )
        await page.screenshot({ path: `.tmp/browser/fail-${Date.now()}.png` }).catch(() => {})
      }
    },
    text: async () => (await page.locator('main').first().innerText()).replace(/\n{2,}/g, '\n'),
    shot: async (name) => {
      await page.screenshot({ path: `.tmp/browser/${name}.png`, fullPage: true })
    },
    async done() {
      if (problems.length)
        console.log(`  problemi del browser:\n    ${[...new Set(problems)].join('\n    ')}`)
      await browser.close()
      process.exit(failed ? 1 : 0)
    },
  }
}
